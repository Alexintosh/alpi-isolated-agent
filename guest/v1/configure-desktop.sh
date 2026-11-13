#!/bin/sh
# Guest-owned configuration through the stock WrapVM launcher and NSS store.
# No private CA key, host credential, or TLS verification override enters here.
set -eu
proxy="$1"
architecture="$2"
case "$proxy" in http://192.0.2.1:43983|http://192.0.2.1:43989) ;; *) exit 1 ;; esac
root="$HOME/.harness-isolated"
step=directories
trap 'printf "%s\n" "$step" > "$root/desktop-configure-stage"' EXIT
mkdir -p "$HOME/.config" "$HOME/.pki/nssdb"
chmod 700 "$HOME/.pki/nssdb"
step=certutil
command -v certutil >/dev/null
step=stock-flags
test -r /etc/wrap/chrome-flags.conf
cat /etc/wrap/chrome-flags.conf > "$HOME/.config/chrome-flags.conf.next"
printf '\n--proxy-server=%s\n--disable-quic\n' "$proxy" >> "$HOME/.config/chrome-flags.conf.next"
# Rosetta cannot execute Chrome's namespace zygote on the verified Mac.
# Only the untrusted guest browser uses this stock flag; Electron stays sandboxed.
case "$architecture" in x64) printf '%s\n' '--no-sandbox' >> "$HOME/.config/chrome-flags.conf.next" ;; arm64) ;; *) exit 1 ;; esac
mv "$HOME/.config/chrome-flags.conf.next" "$HOME/.config/chrome-flags.conf"
cat "$HOME/.config/chrome-flags.conf" "$root/ca.crt" | sha256sum > "$root/desktop-settings.next"
changed=1
if cmp -s "$root/desktop-settings.next" "$root/desktop-settings"; then changed=0; fi
db="sql:$HOME/.pki/nssdb"
step=trust-store
if ! test -f "$HOME/.pki/nssdb/cert9.db"; then certutil -d "$db" -N --empty-password; fi
if certutil -d "$db" -L -n harness-isolated >/dev/null 2>&1; then
  certutil -d "$db" -D -n harness-isolated
fi
certutil -d "$db" -A -t 'C,,' -n harness-isolated -i "$root/ca.crt"
# Leave the image's desktop supervisor and X server intact. Its stop command
# returns before the desktop exits, so stop/start races with its own supervisor.
# Only restart Chrome when its public trust/proxy settings actually changed.
if [ "$changed" = 1 ] && curl -fsS -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  step=chrome-close
  "$root/node/bin/node" <<'NODE'
const timer=setTimeout(()=>process.exit(1),10000);
(async()=>{
  const version=await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const socket=new WebSocket(version.webSocketDebuggerUrl);
  let requested=false, checking=false;
  // Chromium may acknowledge Browser.close and then reset its WebSocket.
  // Confirm that CDP actually stopped instead of treating that reset as failure
  // (or treating any socket error as successful shutdown).
  const confirmClosed=async()=>{
    if(checking)return;
    if(!requested)process.exit(1);
    checking=true;
    for(;;){
      try{await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(500)});}
      catch(error){if(error.cause?.code==='ECONNREFUSED'){clearTimeout(timer);process.exit(0);return;}}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  };
  socket.onopen=()=>{requested=true;socket.send(JSON.stringify({id:1,method:'Browser.close'}));};
  socket.onclose=confirmClosed;
  socket.onerror=confirmClosed;
})().catch(()=>process.exit(1));
NODE
fi
step=desktop-start
/opt/wrap/bin/wrap-desktop start >"$root/desktop-start.log" 2>&1
mv "$root/desktop-settings.next" "$root/desktop-settings"
step=ready
