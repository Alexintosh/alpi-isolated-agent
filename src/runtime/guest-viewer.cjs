const net = require('node:net');

const unavailable = () => new Error('The guest desktop viewer is unavailable.');

// No HTTP parsing, authentication, or guest-selected destinations here. The
// main process holds the password and supplies auth through its dedicated session.
async function openGuestViewer({ assertCurrent, passwordChannel, openChannel, focus, signal,
  maxClients = 16, monitorInterval = 2000 }) {
  const lifetime = new AbortController();
  const clients = new Set(), tasks = new Set();
  let closed = false, closing, monitor, checking = false;
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
  const track = promise => {
    tasks.add(promise);
    promise.finally(() => tasks.delete(promise)).catch(() => {});
    return promise;
  };
  const abort = () => { void close(); };
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(monitor);
    signal?.removeEventListener('abort', abort);
    lifetime.abort();
    for (const client of clients) client.dispose();
    closing = (async () => {
      await new Promise(resolve => server.close(() => resolve()));
      // A channel creation already in flight still belongs to this lease. Its
      // continuation stops and drains it even if it arrives after cancellation.
      while (tasks.size) await Promise.allSettled([...tasks]);
    })();
    return closing;
  };
  const validate = async () => {
    if (closed) throw unavailable();
    await assertCurrent(lifetime.signal);
    if (closed) throw unavailable();
  };
  const ownChannel = async create => {
    const channel = await create(lifetime.signal);
    channel.done.catch(() => {});
    if (closed) {
      channel.output.resume(); channel.input.destroy(); channel.stop();
      await channel.done.catch(() => {});
      throw unavailable();
    }
    return channel;
  };
  server.on('connection', socket => {
    socket.on('error', () => {});
    if (closed || clients.size >= maxClients) { socket.destroy(); return; }
    let channel, disposed = false, finished = false;
    const client = { dispose() {
      if (disposed) return;
      disposed = true;
      socket.destroy();
      if (channel) {
        socket.unpipe(channel.input); channel.output.unpipe(socket);
        channel.input.destroy(); channel.output.resume(); channel.stop();
      }
      if (finished) clients.delete(client);
    } };
    clients.add(client);
    socket.once('close', () => client.dispose());
    track((async () => {
      try {
        await validate();
        if (disposed) return;
        channel = await ownChannel(openChannel);
        if (disposed || closed) { client.dispose(); channel.input.destroy(); channel.output.resume(); channel.stop(); return; }
        channel.input.on('error', () => client.dispose());
        channel.output.on('error', () => client.dispose());
        // Observe failures immediately, including during post-open validation.
        const completion = track(channel.done.then(() => {
          if (!channel.output.readableEnded) client.dispose();
        }, () => client.dispose()));
        await validate();
        if (disposed || closed) return;
        socket.pipe(channel.input); channel.output.pipe(socket); socket.resume();
        await completion;
      } catch {
        client.dispose();
        // Validation failure revokes all connections. Channel transport errors
        // are handled by completion and only dispose their own client.
        void close();
      } finally {
        if (channel && (disposed || closed)) await channel.done.catch(() => {});
        finished = true;
        if (disposed) clients.delete(client);
      }
    })());
  });
  server.on('error', abort);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await validate();
    const passwordTask = track((async () => {
      const channel = await ownChannel(passwordChannel);
      let password = '', bytes = 0, excessive = false, timedOut = false;
      const stop = () => { channel.input.destroy(); channel.output.resume(); channel.stop(); };
      const timeout = setTimeout(() => { timedOut = true; stop(); }, 5000); timeout.unref();
      lifetime.signal.addEventListener('abort', stop, { once: true });
      channel.output.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 256) { excessive = true; password = ''; stop(); }
        else if (!excessive) password += chunk.toString('latin1');
      });
      channel.input.end();
      try {
        await channel.done;
        const token = password.replace(/\r?\n$/, '');
        if (closed || excessive || timedOut || token.length < 32 || token.length > 128 || /[^a-fA-F0-9]/.test(token))
          throw unavailable();
        return token;
      } finally {
        clearTimeout(timeout); lifetime.signal.removeEventListener('abort', stop);
        stop();
      }
    })());
    const password = await passwordTask;
    await validate();
    await new Promise((resolve, reject) => {
      const onError = () => reject(unavailable());
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
    });
    await validate();
    monitor = setInterval(() => {
      if (closed || checking) return;
      checking = true;
      track(validate().catch(() => { void close(); }).finally(() => { checking = false; }));
    }, monitorInterval);
    monitor.unref();
    return {
      origin: `http://127.0.0.1:${server.address().port}`,
      password,
      isClosed: () => closed,
      async focusBrowser() {
        try {
          await validate();
          await focus(lifetime.signal);
          await validate();
        } catch { void close(); throw unavailable(); }
      },
      close,
    };
  } catch {
    await close();
    throw unavailable();
  }
}

module.exports = { openGuestViewer };
