import {HMLogger} from '../logger';
import TcpSocket from 'react-native-tcp-socket';
import {WyomingPacket} from './packet.ts';
import {Buffer} from 'buffer';
import {CheyenneSocket} from '../cheyenne.ts';
import {ClientEvent, ClientMessage, SavedSettings} from '../proto/hassmic';
import {Settings} from '../settings.ts';
import {APP_VERSION, AUDIO_INFO} from '../constants';
import {MicAudio} from '../mic.ts';
import {DeviceEventEmitter} from 'react-native';
import {PCMPlayer} from '../pcm';
import Sound from 'react-native-sound';

const Logger = new HMLogger('wyoming');

// state machine that handles bytes as they come in from the stream and emits
// complete wyoming packets as they're ready.
class ReceiveStateMachine {
  // incoming data queue
  private _handleCompletePacket: (p: WyomingPacket) => void = p => {};
  private _dataQueue: any = [];
  private start = 0;

  // construct with a callback for what to do when a packet is formed.
  constructor(cb: (p: WyomingPacket) => void) {
    this._handleCompletePacket = cb;
    // initialize the generator. Not sure why it needs an empty call to next()
    // before it works properly, but it does.
    this._byteHandler.next().then();
  }

  // This is the main point of interaction. Feeds bytes to the state machine.
  handleBytes = async (b: Uint8Array) => {
    // Ensure Uint8Array is constructed with ArrayBuffer
    this._dataQueue.push(...b);
    // If we're waiting for data, we can just continue processing
    await this._byteHandler.next();
  };

  dataQueueShift() {
    if (this.start >= this._dataQueue.length) {
      return undefined;
    }
    const result = this._dataQueue[this.start++];
    if (this.start >= this._dataQueue.length - this.start) {
      //move all the elements into the free space at beginning
      let d = 0;
      for (let i = this.start; i < this._dataQueue.length; ++i) {
        this._dataQueue[d++] = this._dataQueue[i];
      }
      this.start = 0;
      this._dataQueue.length = d;
    }
    return result;
  }

  // State machine, implemented as a generator function. The function consumes
  // bytes (fed in by next()) and emits Wyoming packets using the callback
  // passed in the constructor.
  private _byteHandler = (async function* (ethis) {
    while (true) {
      let jsonBytes: string[] = [];
      let pktout: WyomingPacket = new WyomingPacket({});
      let d: number | undefined = 0;

      do {
        d = ethis.dataQueueShift();
        if (d === undefined) {
          // If we run out of data, we need to wait for more
          yield;
          // If we were waiting for data, we can continue processing
          continue;
        } else {
          jsonBytes.push(String.fromCharCode(d || 0));
        }
      } while (d != '\n'.charCodeAt(0));

      // if we only got a newline, ignore it and start over.
      if (jsonBytes.length == 1) {
        continue;
      }

      // otherwise, try to parse the message
      let pktobj: {[key: string]: any} = {};
      try {
        pktobj = JSON.parse(jsonBytes.join(''));
        pktout = new WyomingPacket(pktobj);
        jsonBytes = [];
      } catch (e) {
        Logger.debug(
          `Error parsing wyoming json message: ${jsonBytes.join('')}`,
        );
        continue;
      }

      // If there's data, we have to read it.
      //TODO: Need to manage index of data if end of buffer is reached
      let data_bytes = pktobj['data_length'] || 0;
      if (data_bytes > 0) {
        let objData = [];

        do {
          d = ethis.dataQueueShift();
          if (d === undefined) {
            // If we run out of data, we need to wait for more
            yield;
            continue;
          }
          objData.push(String.fromCharCode(d));
        } while (objData.length < pktobj['data_length']);

        if (objData.length > 0) {
          try {
            pktout.setData(JSON.parse(objData.join('')));
          } catch (e) {
            Logger.debug(
              'Error parsing wyoming json data: ' + objData.join(''),
            );
            continue;
          }
        }
      }

      // If there was a payload, read in a similar way. The difference is that
      // this is simply raw bytes, not JSON, so we can just allocate an array to
      // hold it and not worry about converting to/from codepoints or JSON.
      let payload_bytes = pktobj['payload_length'] || 0;
      let payload_idx = 0;
      if (payload_bytes > 0) {
        let objPayload = new Uint8Array(payload_bytes);
        do {
          d = ethis.dataQueueShift();
          if (d === undefined) {
            // If we run out of data, we need to wait for more
            yield;
            continue;
          }
          objPayload[payload_idx] = d;
          payload_idx++;
        } while (payload_idx < payload_bytes);

        // If we got here, we have enough data to read the payload
        pktout.setPayload(objPayload);
      }

      // Finally, emit the packet. ethis is bound to the RecvStateMachine
      // instance.
      await ethis._handleCompletePacket(pktout);
    }
  })(this);
}

export class ClientHandler {
  private _socket: TcpSocket.Socket | null = null;
  private _packetBuilder = new ReceiveStateMachine(
    async (p: WyomingPacket) => await this._handleEvent(p),
  );
  private _writeBuffer: any = [];
  private _activePCMStream: number | null = null;
  private _pipelineRunning: boolean = false;
  private _wakewordDetectMode: boolean = false;
  private _lastKeepAlive: number = 0;
  private wakeword = null;

  constructor(socket: TcpSocket.Socket) {
    this._socket = socket;
    this._socket.setTimeout(60e3);

    // Handles incomming data from the socket
    socket.on('data', async d => {
      if (typeof d == 'string') {
        await this._handleIncomingData(
          Uint8Array.from(Array.from(d).map(l => l.charCodeAt(0) || 0)),
        );
      } else {
        this._handleIncomingData(Uint8Array.from(d));
      }
    });

    // Handle socket buffer drain event so continue to send data
    socket.on('drain', () => {
      Logger.info(
        `Socket ${socket.remoteAddress}:${socket.remotePort} drained`,
      );
      this._byteWriterHandler.next();
    });

    // Set WW sound at connection time
    Settings.getWakewordSound().then(ww => {
      this.wakeword = this._getWakewordRequire(ww);
    });

    // Handle ww sound change
    Settings.registerSettingsChangedCallback(async (s: SavedSettings) => {
      if (s.wakewordSound !== undefined) {
        this.wakeword = this._getWakewordRequire(s.wakewordSound);
        Logger.info(`Updated wakeword sound to ${s.wakewordSound}`);
      }
    });
  }

  private _getWakewordRequire(wakeword: string) {
    switch (wakeword) {
      case 'Alexa':
        return require('../../assets/sounds/alexa.mp3');
      case 'Bubble':
        return require('../../assets/sounds/bubble.mp3');
      case 'Ding':
        return require('../../assets/sounds/ding.mp3');
      case 'HomeAssistant':
        return require('../../assets/sounds/havpe.mp3');
    }
    return null;
  }

  private _handleIncomingData = async (d: Uint8Array) => {
    await this._packetBuilder.handleBytes(d);
  };

  private _byteWriterHandler = (async function* (ethis) {
    while (true) {
      // Loop buffer and send over socket
      if (ethis._writeBuffer.length > 0) {
        let p = ethis._writeBuffer.shift();
        if (p && ethis._socket && ethis._socket.readyState === 'open') {
          try {
            // If the write failed, we need to wait for the socket to drain
            let repeatTry = false;
            while (!ethis._socket.write(p.toBytes())) {
              Logger.debug(
                `Socket ${
                  ethis._socket.remotePort
                } write failed [${p.getType()}]`,
              );
              yield;
              if (['audio-chunk', 'ping', 'pong'].indexOf(p.getType()) != -1) {
                p = ethis._writeBuffer.shift();
              } else {
                repeatTry = true;
              }
            }
            if (repeatTry) {
              Logger.debug(
                `Socket ${
                  ethis._socket.remotePort
                } write succeeded after retry: [${p.getType()}]`,
              );
            }
          } catch (e: any) {
            Logger.error(
              `Error writing to socket ${ethis._socket.remotePort}: ${e}`,
            );
          }
        } else {
          Logger.error('No socket to write to or socket not open');
        }
      }
      yield;
    }
  })(this);

  socket_port = () => {
    if (this._socket) {
      return this._socket.remotePort;
    }
  };

  socket_id = this._socket?._id || 0;

  writePkt = (p: WyomingPacket) => {
    if (this._socket) {
      this._writeBuffer.push(p);
      this._byteWriterHandler.next();
    }
  };

  end = () => {
    this.AudioDoneEventListener.remove();
    if (this._socket) {
      Logger.debug(
        `Closing socket ${this._socket.remoteAddress}:${this._socket.remotePort}`,
      );
      this._socket.end();
      this._socket = null;
    }
  };

  destroy = () => {
    this.AudioDoneEventListener.remove();
    if (this._socket) {
      Logger.debug(
        `Destroying socket ${this._socket.remoteAddress}:${this._socket.remotePort}`,
      );
      this._socket.destroy();
      this._socket = null;
    }
  };

  private _handleEvent = async (p: WyomingPacket) => {
    let ptype = p.getType();

    if (['audio-chunk', 'ping', 'pong'].indexOf(ptype) == -1) {
      Logger.debug(`Received event [${this._socket?.remotePort}]: ${p}`);
      try {
        CheyenneSocket.sendMessage(
          ClientMessage.create({
            msg: {
              oneofKind: 'clientEvent',
              clientEvent: ClientEvent.create({
                event: {
                  oneofKind: 'wyomingEvent',
                  wyomingEvent: p.toProto(),
                },
              }),
            },
          }),
        );
      } catch (e) {
        Logger.error(
          `Error forwarding wyoming event to hassmic integration: ${e}`,
        );
      }
    }

    try {
      switch (ptype) {
        case 'describe':
          let zcuuid: string = await Settings.getHMUUID();
          Logger.info('Got wyoming `describe` request, responding with info');
          let resp = new WyomingPacket({
            type: 'info',
            data: {
              version: APP_VERSION,
              asr: [],
              tts: [],
              handle: [],
              intent: [],
              wake: [],
              satellite: {
                name: 'Hassmic Wyoming ' + zcuuid.slice(0, 8),
                attribution: {
                  name: '',
                  url: '',
                },
                installed: true,
                description: 'Hassmic Wyoming ' + zcuuid.slice(0, 8),
                version: APP_VERSION,
                area: null,
                snd_format: {
                  channels: 1,
                  rate: 16000,
                  width: 2,
                },
              },
            },
          });
          Logger.debug(
            `Sending info response to socket ${
              this._socket?.remotePort
            }: ${resp.toString()}`,
          );
          this.writePkt(resp);
          break;

        case 'run-satellite':
          zcuuid = await Settings.getHMUUID();
          Logger.info('Starting satellite at server request');
          resp = new WyomingPacket({
            type: 'run-pipeline',
            data: {
              name: 'Hassmic Wyoming ' + zcuuid.slice(0, 8),
              start_stage: 'wake',
              end_stage: 'tts',
              restart_on_end: true,
              snd_format: {
                rate: AUDIO_INFO.rate,
                width: AUDIO_INFO.width,
                channels: AUDIO_INFO.channels,
              },
            },
          });
          this.writePkt(resp);
          this._pipelineRunning = true;
          MicAudio.start();
          break;

        case 'pause-satellite':
          Logger.info('Stopping satellite at server request');
          this._pipelineRunning = false;
          MicAudio.stop();
          break;

        case 'detect':
          Logger.info('Starting (on-server) wakeword detection...');
          DeviceEventEmitter.emit('wyoming-pipeline-start', {
            socket_id: this._socket?._id,
          });
          // Start streaming audio
          MicAudio.unmute();
          this._wakewordDetectMode = true;
          break;

        case 'error':
          Logger.debug(`Error from server: ${p.getProp('text')}`);
          break;

        case 'detection':
          this._wakewordDetectMode = false;
          MicAudio.mute();
          try {
            this.playSound(this.wakeword);
          } catch (e) {
            console.log(`cannot play the wakeword sound`, e);
          }
          break;

        case 'transcribe':
          MicAudio.unmute();
          break;

        case 'voice-started':
          // Voice detection stopped, stop stremaing audio
          MicAudio.unmute();
          break;

        case 'voice-stopped':
          // Voice detection stopped, stop stremaing audio
          MicAudio.mute();
          break;

        case 'audio-start':
          Logger.info('Starting audio stream...');
          this._activePCMStream = await PCMPlayer.startAudioStream({
            encoding: '16bit',
            usage: 'announce',
            sampleRate: p.getProp('rate') || 16000,
            channels: 1,
            mode: 'streaming',
            gain: await Settings.getAnnounceVolume(),
          });
          Logger.info(`Audio stream id: ${this._activePCMStream}`);
          break;

        case 'audio-chunk':
          if (this._activePCMStream) {
            await PCMPlayer.writeAudioStream(
              this._activePCMStream,
              p.getPayload(),
            );
          } else {
            Logger.info('No active PCM stream!');
          }

          // Keepalive activities
          // These are not done on an interval as it does not fire reliably
          // during audio streaming
          this.audioStreamKeepAliveActivities();
          break;

        case 'audio-stop':
          Logger.info('Audio done.');
          if (this._activePCMStream) {
            await PCMPlayer.stopAudioStream(this._activePCMStream);
          }
          break;

        case 'ping':
          // don't log ping/pong responses because they spam the console.
          resp = new WyomingPacket({type: 'pong'});
          this.writePkt(resp);
          break;
      }
    } catch (e: any) {
      Logger.error(`Error processing incoming packet: ${e}`);
    }
  };

  audioStreamKeepAliveActivities = () => {
    // These activities are needed during audio streaming to prevent the
    // server from thinking the connection is dead and giving a timeout error
    if (this._lastKeepAlive + 2e3 < Date.now()) {
      let pkt = new WyomingPacket({type: 'ping'});
      Logger.debug(
        `Sending keepalive ping to socket ${this._socket?.remotePort}`,
      );
      this.writePkt(pkt);

      if (this._wakewordDetectMode) {
        let keepAliveChunk = new Uint8Array(160); // 10ms of silence at 16kHz
        Logger.debug(
          `Sending blank audio keepalive to socket ${this._socket?.remotePort}`,
        );
        this.sendAudioData(keepAliveChunk);
      }

      // Update the last keepalive time
      this._lastKeepAlive = Date.now();
    }
  };

  playSound(wwsound: string | any) {
    const callback = (error: any, sound: any) => {
      if (error) {
        Logger.debug('Error loading sound: ' + error);
        return;
      }
      sound.play(() => {
        // Success counts as getting to the end
        // Release when it's done so we're not using up resources
        sound.release();
      });
    };

    if (!wwsound || wwsound === 'None') {
      return;
    }
    const sound = new Sound(wwsound, error => callback(error, sound));
  }

  sendAudioData = (data: Uint8Array) => {
    if (!data || data.length == 0) {
      Logger.warning('Not sending empty audio data');
      return;
    }
    if (!this._pipelineRunning) {
      Logger.warning('Pipeline not running; not sending audio chunk');
      return;
    }
    let resp = new WyomingPacket({
      type: 'audio-chunk',
      data: {
        rate: 16000,
        width: 2,
        channels: 1,
      },
    });
    resp.setPayload(data);
    try {
      this.writePkt(resp);
    } catch (e: any) {
      Logger.error(
        `Error writing audio packet: ${this._socket?.remotePort}: ${e}`,
      );
    }
  };

  // Listen for audio done event from PCMPlayer and send a played message
  // This gives an fairly accurate end to playing audio and ensures the Wyoming
  // satellite knows when the audio has finished playing.
  AudioDoneEventListener = DeviceEventEmitter.addListener(
    'PCMAudio.AudioDone',
    e => {
      Logger.info(`Audio done event received: ${e}`);
      let resp = new WyomingPacket({
        type: 'played',
      });
      Logger.debug(
        `Sending audio played message [${this._socket?.remotePort}]`,
      );
      this.writePkt(resp);
      this._activePCMStream = null;
    },
  );
}
