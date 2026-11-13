// This list belongs to the application. A payload never supplies executable
// paths, hashes, archive instructions or release metadata to trust.
const files=[
 ['v1/ubuntu-24.04-arm64.img',616522752,'50e24e1fb79e89116e939d90aa7738f7af48c442fa1bc2510131e0b39c50348e',0o600],
 ['v1/guest-runtime.tar.gz',309313772,'7c67fe087ef9c2836f4e342fa57062c74d3838ffd243dbb7c97caa820b71c26b',0o600],
 ['v1/guest-runtime.json',466,'1ed85f926b1634bd9cbf51aade063dcfcc04f6aefa2b1ddc9b60e9a52323c06a',0o600],
 ['v1/x64/guest-runtime.tar.gz',301047887,'c39c52cb465fe5e60e6c53ff3b23b466e130d927342bae652f4d1c0791c8ea11',0o600],
 ['v1/x64/guest-runtime.json',464,'0d59375f5455e7a996c55e8647355240a5f7e67ad1ceac69c6b90bfcca6fb87f',0o600],
 ['v1/wrapvm-stock-amd64.tar',1394883072,'e87b3757c0e05b97ca35291e1963e47b20d46c0a741886e39e0d4738b3a678df',0o600],
 ['m0/iron-bin/iron-proxy',51363634,'5d46445310b13b1c86bdb51aac5db1c70b3f9a47365d704337f7e16e8acd7ba6',0o755],
 ['v1/lima/bin/limactl',29056416,'8d07e22c4f9616ff86aed8e509268d24e2d5f073a6d2bbe6024f3b17b1c4c5d6',0o755],
 ['v1/lima/bin/lima-guestagent.Linux-aarch64',48103608,'ccdf20811f9068b7228d8b8e52f266d5af6982173728e861643a116bbc95d898',0o755],
 ['v1/agent-browser-linux-musl-arm64-0.41.2',15924440,'730a5168153e27ad1243ebe960157e69de0f24531fbbac9a040856a491bf491f',0o755],
 ['smolvm/release.tar.gz',41187333,'8ebda502e332c739fdfc13b059be982cca66da9253c5229b4586af02c92781d9',0o600],
 ['v1/host-python-3.13.18-darwin-arm64.tar.gz',25479437,'7a2384641584ab9984221fcb0fc9265df465922af71be71410529e2a9c3f0540',0o600],
].map(([path,bytes,sha256,mode])=>Object.freeze({path,bytes,sha256,mode}));
const archives=[
 {file:'smolvm/release.tar.gz',destination:'smol-runtime',root:'smolvm-1.34.1-darwin-arm64'},
 {file:'v1/host-python-3.13.18-darwin-arm64.tar.gz',destination:'v1/host-python',root:'python'},
].map(Object.freeze);
module.exports=Object.freeze({version:1,id:'personal-v1-20261112-r1',files:Object.freeze(files),archives:Object.freeze(archives)});
