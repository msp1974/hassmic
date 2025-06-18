import {HMLogger} from '../logger';
import {WyomingEvent} from '../proto/hassmic';

const Logger = new HMLogger('wyoming.ts');

// Represents a wyoming protocol packet (JSON and optional payload)
export class WyomingPacket {
  private _type: string = '';
  private _data: {[key: string]: any} = {};
  private _payload: Uint8Array = new Uint8Array();

  // Construct a packet from a blob of data
  constructor(fromData: any | undefined) {
    if (fromData) {
      this._type = fromData['type'] || '';
      if ('data' in fromData) {
        for (let [k, v] of Object.entries(fromData['data'])) {
          this._data[k] = v;
        }
      }
    }
  }

  // Validates a packet. Logs a warning if invalid and returns false. Otherwise
  // returns true.
  validate: () => boolean = () => {
    if (!this._type) {
      Logger.warning('WyomingPacket missing type');
      return false;
    }
    if (this.getPayloadLength() != this._payload.length) {
      Logger.warning(
        `WyomingPacket payload length does not match stated length: ${this.getPayloadLength()} != ${
          this._payload.length
        }`,
      );
      return false;
    }

    return true;
  };

  // Shortcut method for getting the type of this packet.
  getType = () => {
    return this._type;
  };

  // Get a property on the packet.
  getProp(prop: string) {
    return this._data[prop] || undefined;
  }

  // Set a property on the packet.
  setProp(prop: string, val: any) {
    this._data[prop] = val;
  }

  // Return the payload
  getPayload = () => {
    return this._payload;
  };

  // Set the payload and update the payload length.
  setPayload(payload: Uint8Array | null) {
    if (!payload) {
      this._payload = new Uint8Array();
    } else {
      this._payload = payload;
    }
  }

  // Return the payload length, or zero if there is no payload.
  getPayloadLength = () => {
    return this._payload.length;
  };

  getData = () => {
    return JSON.stringify(this._data);
  };

  setData = (data: {[key: string]: any}) => {
    if (data && typeof data === 'object') {
      this._data = data;
    } else {
      Logger.error('Invalid data for WyomingPacket, must be an object');
      this._data = {};
    }
  };

  getDataLength = () => {
    return JSON.stringify(this._data).length;
  };

  // If this packet has any data in it, return it as a JSON string. Otherwise
  // return a placeholder.
  toString = () => {
    return JSON.stringify({
      type: this._type,
      data: this._data,
      payload_length: this.getPayloadLength(),
    });
  };

  toProto = () => {
    try {
      // replace audio-chunk with audioChunk and similar to match compiler
      let kind = this.getType().replaceAll(/-([a-z])/g, match =>
        match[1].toUpperCase(),
      );
      Logger.info(`Sending wyoming packet: ${this.toString()}`);
      let p: WyomingEvent = WyomingEvent.create({
        rawJson: this.toString(),
        payload: this.getPayload(),
        event: {
          // @ts-ignore
          oneofKind: kind,
          [kind]: JSON.parse(this.getData()),
        },
      });
      if (!p.event.oneofKind) {
        Logger.warning(`Wyoming event type '${kind}' not defined!`);
      }
      return p;
    } catch (e: any) {
      Logger.error(`Error building proto: ${e}`);
      return WyomingEvent.create();
    }
  };

  toBytes = () => {
    let pl = this._payload.length;
    let jsonstr = JSON.stringify({
      type: this._type,
      payload_length: pl,
      data: this._data,
    });
    let outBytes = new Uint8Array(jsonstr.length + this._payload.length + 1);
    let j = 0;
    for (let i = 0; i < jsonstr.length; i++) {
      outBytes[j] = jsonstr[i].codePointAt(0) || 0;
      j++;
    }
    outBytes[j] = '\n'.codePointAt(0) || 0;
    j++;
    for (let i = 0; i < this._payload.length; i++) {
      outBytes[j] = this._payload[i];
      j++;
    }
    return outBytes;
  };
}
