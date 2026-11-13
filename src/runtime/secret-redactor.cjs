const { Transform } = require('node:stream');

// Incremental byte filter: retain only a possible secret prefix, so ordinary
// SSE chunks are not delayed by a fixed window. No promise against arbitrary
// upstream encodings/covert channels; literal and JSON-escaped values covered.
class SecretRedactor extends Transform {
  constructor(secrets, { maxBytes = 64 * 1024 * 1024 } = {}) {
    super();
    const variants = [...new Set(secrets.flatMap(value => {
      if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 65536) throw new Error('Invalid redaction value');
      return [value, JSON.stringify(value).slice(1, -1)];
    }))];
    this.patterns = variants.map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
    this.pending = Buffer.alloc(0); this.total = 0; this.maxBytes = maxBytes;
  }
  consume(chunk, final) {
    const data = Buffer.concat([this.pending, chunk]); this.pending = Buffer.alloc(0);
    let offset = 0, plainStart = 0;
    while (offset < data.length) {
      const tail = data.subarray(offset);
      // Defer a full short pattern if it is also a prefix of a longer secret.
      if (!final && this.patterns.some(pattern => tail.length < pattern.length && pattern.subarray(0, tail.length).equals(tail))) break;
      const match = this.patterns.find(pattern => tail.length >= pattern.length && tail.subarray(0, pattern.length).equals(pattern));
      if (match) {
        if (offset > plainStart) this.push(data.subarray(plainStart, offset));
        this.push(Buffer.from('[redacted]')); offset += match.length; plainStart = offset;
      } else offset++;
    }
    if (offset > plainStart) this.push(data.subarray(plainStart, offset));
    if (offset < data.length) this.pending = Buffer.from(data.subarray(offset));
  }
  _transform(chunk, _encoding, done) {
    this.total += chunk.length;
    if (this.total > this.maxBytes) return done(new Error('Response size limit exceeded'));
    this.consume(chunk, false); done();
  }
  _flush(done) { this.consume(Buffer.alloc(0), true); done(); }
}
module.exports = { SecretRedactor };
