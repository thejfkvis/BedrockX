const { RakClient } = require('./binding')
const { EventEmitter } = require('events')
const { MessageID } = require('./constants')

class Client extends EventEmitter {
  constructor(hostname, port, options = {}) {
    super()
    this.client = new RakClient(hostname, port, options)
    this.startListening()
  }
  
  connect() {
    return this.client.connect(this)
  }

  close() {
    return this.client.close()
  }

  // Handle inbound packets and emit events
  startListening() {
    this.client.listen((buffers, address, guid) => {
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        const buf = Buffer.from(buffer);
        const id = buf[0];

        try {
          if (id < MessageID.ID_USER_PACKET_ENUM) {
            // Internal RakNet messages: we handle & emit
            switch (id) {
              case MessageID.ID_UNCONNECTED_PONG:
                if (buf.byteLength > 5) {
                  const extra = Buffer.from(buf.slice(5));
                  this.emit('pong', { extra });
                } else {
                  this.emit('pong', {});
                }
                break;
              case MessageID.ID_CONNECTION_REQUEST_ACCEPTED:
                this.emit('connect', {
                  address,
                  guid
                });
                break;
              case MessageID.ID_CONNECTION_LOST:
              case MessageID.ID_DISCONNECTION_NOTIFICATION:
              case MessageID.ID_CONNECTION_BANNED:
              case MessageID.ID_INCOMPATIBLE_PROTOCOL_VERSION:
                this.emit('disconnect', {
                  address,
                  guid,
                  reason: id
                });
                break;
              default:
                break;
            }
          } else {
            this.emit('encapsulated', {
              buffer: buf,
              address,
              guid
            });
          }
        } catch (e) {
          this.emit('error', e, buf);
        }
      }
    }, this);
  }

  send(message, priority, reliability, orderingChannel = 0, broadcast = false) {
    // When you Buffer.from/allocUnsafe, it may put your data into a global buffer, we need it in its own buffer
    if (message instanceof Buffer && message.buffer.byteLength !== message.byteLength) message = new Uint8Array(message)

    const ret = this.client.send(message instanceof ArrayBuffer ? message : message.buffer, priority, reliability, orderingChannel, broadcast)

    if (ret <= 0) throw new Error(`Failed to send: ${ret}`)
  }
}

module.exports = { Client }