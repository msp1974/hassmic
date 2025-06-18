// Handle connection to Wyoming clientss
import TcpSocket from 'react-native-tcp-socket';
import {HMLogger} from '../logger';
import {WYOMING_PORT} from '../constants';
import {Settings} from '../settings';
import {PCMPlayer} from '../pcm';
import {SavedSettings} from '../proto/hassmic';
import {DeviceEventEmitter} from 'react-native';
import Sound from 'react-native-sound';
import {ClientHandler} from './client-handler';

type CallbackType<T> = ((s: T) => void) | null;

const Logger = new HMLogger('wyoming.ts');

// Class that actually defines a Wyoming protocol server. A single instance of
// this class is constructed on startup and exported from this file.
export class WyomingServer_ {
  private _server: TcpSocket.Server | null = null;
  private _clients: Record<string, ClientHandler> = {};
  private _pipelineSocketId: string | null = null;
  private _pipelineStartEventListender: any = null;
  private _activePCMStream: number | null = null;

  constructor() {
    Settings.registerSettingsChangedCallback(async (s: SavedSettings) => {
      Logger.info('Got updated settings');
      if (s.announceVolume !== undefined && this._activePCMStream != null) {
        Logger.info(`Setting new gain to ${s.announceVolume}`);
        await PCMPlayer.setGain(this._activePCMStream, s.announceVolume);
      } else {
        Logger.info(
          `Not setting gain: ${s.announceVolume} ${this._activePCMStream}`,
        );
      }
    });

    Sound.setCategory('Playback', true); // true = mixWithOthers
  }

  // settable callback for connection state
  private _connectionStateCallback: CallbackType<boolean> = null;
  setConnectionStateCallback = (cb: CallbackType<boolean>) => {
    this._connectionStateCallback = cb;
  };
  private _setConnectionState = (s: boolean) => {
    this._connectionStateCallback?.(s);
  };

  // Send a chunk of pcm audio
  sendAudioData = (data: Uint8Array) => {
    if (
      this._pipelineSocketId &&
      this._clients.hasOwnProperty(this._pipelineSocketId)
    ) {
      this._clients[this._pipelineSocketId].sendAudioData(data);
    }
  };

  startServer = async () => {
    this._pipelineStartEventListender = DeviceEventEmitter.addListener(
      'wyoming-pipeline-start',
      (data: any) => {
        this._pipelineSocketId = data.socket_id;
      },
    );

    if (!this._server) {
      Logger.debug('Starting TCP server');
      // Here you would start your TCP server
      try {
        this._server = TcpSocket.createServer((socket: TcpSocket.Socket) => {
          Logger.info(
            `Wyoming Got connection from ${socket.remoteAddress}:${socket.remotePort}`,
          );
          if (!this._clients.hasOwnProperty(socket._id)) {
            this._clients[socket._id] = new ClientHandler(socket);
            this._setConnectionState(true);
            Logger.info('Wyoming all set up -- waiting');
          } else {
            Logger.warn(
              'Wyoming already has this socket, dropping new connection',
            );
            socket.destroy();
          }

          socket.on('error', (err: Error) => {
            Logger.info(`Socket error: ${err}`);
          });

          socket.on('timeout', () => {
            Logger.info(
              `Socket timed out on ${socket.remoteAddress}:${socket.remotePort}`,
            );
            if (this._clients[socket._id]) {
              try {
                this._clients[socket._id].destroy();
              } catch (e: any) {
                Logger.error(`Error destroying socket: ${e}`);
              }
              delete this._clients[socket._id];
            }
          });

          socket.on('close', (had_error: boolean) => {
            Logger.info(
              `Closed connection to ${socket.remoteAddress}:${
                socket.remotePort
              } (${had_error ? 'had' : 'no'} errors)`,
            );
            if (this._clients[socket._id]) {
              this._clients[socket._id].end();
              delete this._clients[socket._id];
            }
            if (Object.keys(this._clients).length == 0) {
              this._setConnectionState(false);
            }
          });
        }).listen({port: WYOMING_PORT, host: '0.0.0.0'});
      } catch (e: any) {
        Logger.error(`Error starting TCP server: ${e}`);
        throw e; // Re-throw the error to handle it upstream
      }
    }
  };

  stopServer = async () => {
    Logger.info('stopping server...');
    this._pipelineStartEventListender?.remove();

    const p = new Promise<void>(resolve => {
      this._server?.close(() => resolve());
    });
    Object.entries(this._clients).map(([id, s]) => {
      Logger.info(`Closing socket ${id}`);
      s.destroy();
    });
    this._clients = {};
    await p;
    this._server = null;
    Logger.info('Server stopped');
  };
}
