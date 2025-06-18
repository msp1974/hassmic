import {HMLogger} from './logger';
import {PermissionsAndroid} from 'react-native';
import {AUDIO_INFO} from './constants';
import {WyomingServer} from './wyoming';
import {
  AUDIO_FORMATS,
  AUDIO_SOURCES,
  CHANNEL_CONFIGS,
  InputAudioStream,
} from '@dr.pogodin/react-native-audio';
import { Settings } from './settings';
import { SavedSettings } from './proto/hassmic';

const Logger = new HMLogger('mic.ts');

class MicAudio_ {
  private _chunkListener: any = null;
  private _errorListener: any = null;
  // The stream object, which is used to record audio.
  stream: InputAudioStream | null = null;
  private _micGain: number = 1; // Default mic gain

  constructor() {
    Settings.registerSettingsChangedCallback(async (s: SavedSettings) => {
      if (s.micGain !== undefined) {
        Logger.info(`Setting microphone gain to ${s.micGain}`);
        this._micGain = s.micGain;
      }
    });
  }

  checkPermissions = async () => {
    Logger.info('Checking permissions for audio recording');
    const ok = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    );
    Logger.info(`Audio recording permission is ${ok ? 'granted' : 'denied'}`);
    return ok;
  };

  init = async () => {
    if (await this.checkPermissions()) {
      this.stream = new InputAudioStream(
        AUDIO_SOURCES.VOICE_RECOGNITION,
        AUDIO_INFO.rate, // Sample rate in Hz.
        AUDIO_INFO.channels == 1
          ? CHANNEL_CONFIGS.MONO
          : CHANNEL_CONFIGS.STEREO,
        AUDIO_INFO.width == 2
          ? AUDIO_FORMATS.PCM_16BIT
          : AUDIO_FORMATS.PCM_8BIT,
        4096, // Sampling size.
        false, // do not stop when in background
      );

      this._chunkListener = this.stream.addChunkListener(this._audioChunckCallback.bind(this));
        

      this._errorListener = this.stream.addErrorListener((error) => {
        Logger.error(`Audio stream error: ${error}`);
      });
    } else {
      Logger.error(
        'Audio recording permission denied, cannot initialise stream',
      );
    }
  };

  start = () => {
    if (this.stream) {
      this.stream.start();

      // Fix for Lenovo Smart Clock 2
      // Restarts stream to override google assissant settings
      // which can be set before or after hassmic has started audio streaming.
      // If after, it will stop Wyoming detecting audio, so we restart
      // the stream after 20 seconds to try to avoid issues.
      setTimeout(() => {
        this.stream?.stop();
        setTimeout(() => {
          Logger.info('restarting stream');
          this.stream?.start();
        }, 250);
      }, 20e3); // restart after 20 seconds to avoid issues
    }
  };

  stop = () => {
    if (this.stream) {
      this.stream.removeChunkListener(this._chunkListener);
      this.stream.removeErrorListener(this._errorListener);
      this.stream.stop();
      this.stream.destroy();
      Logger.info('stream stopped');
    }
  };

  mute = () => {
    if (this.stream) {
      this.stream.mute();
      Logger.info('stream muted');
    }
  };

  unmute = () => {
    if (this.stream) {
      this.stream.unmute();
      Logger.info('stream unmuted');
    }
  };

  micGain = this._micGain

  setMicGain = async (gain: number) => {
    if (gain < 1 || gain > 11) {
      Logger.error(`Mic gain out of range: ${gain}`);
      return;
    }
    await Settings.setMicGain(gain);
    Logger.info(`Mic gain set to ${gain}`);
  };

  _increaseVolume16BitPCM = (data: Uint8Array, gain: number) => {
    if (!(data instanceof Uint8Array)) {
      throw new Error('Input must be a Uint8Array.');
    }
    if (data.byteLength % 2 !== 0) {
      throw new Error('Uint8Array byteLength must be even for 16-bit samples.');
    }
    if (typeof gain !== 'number' || gain < 0) {
      throw new Error('Gain must be a non-negative number.');
    }

    // Create a DataView to read and write 16-bit integers
    const dataView = new DataView(data.buffer);
    const numSamples = data.byteLength / 2;

    // Create a new Uint8Array for the output
    const outputUint8Array = new Uint8Array(data.byteLength);
    const outputDataView = new DataView(outputUint8Array.buffer);

    const MAX_16_BIT = 32767;
    const MIN_16_BIT = -32768;

    for (let i = 0; i < numSamples; i++) {
      // Read the original 16-bit sample (little-endian)
      const sample = dataView.getInt16(i * 2, true); // true for little-endian

      // Apply gain
      let newSample = Math.round(sample * gain * (gain * 0.6)); // roughly increasing curve from 0 to 92x

      // Clip the sample to 16-bit limits
      if (newSample > MAX_16_BIT) {
        newSample = MAX_16_BIT;
      } else if (newSample < MIN_16_BIT) {
        newSample = MIN_16_BIT;
      }

      // Write the modified 16-bit sample back (little-endian)
      outputDataView.setInt16(i * 2, newSample, true); // true for little-endian
    }

    return outputUint8Array;
  }

  _audioChunckCallback = (chunk: Uint8Array, chunkId: number) => {
    // Pause the stream for the chunk processing. The point is: if your chunk
    // processing in this function is too slow, and chunks arrive faster than
    // this callback is able to handle them, it will rapidly crash the app,
    // with out of memory error. Muting the stream ignores any new chunks
    // until stream.unmute() is called, thus protecting from the crash.
    // And if your chunk processing is rapid enough, not chunks won't be
    // skipped. The "chunkId" argument is just sequential chunk numbers,
    // by which you may judge whether any chunks have been skipped between
    // this callback calls or not.
    if (this.stream) {
      this.stream.mute();
      if (this.micGain > 1) {
        chunk = this._increaseVolume16BitPCM(chunk, this.micGain);
      }
      WyomingServer.sendAudioData(new Uint8Array(chunk));

      // Resumes the stream.
      this.stream.unmute();
    };
  }
}

export const MicAudio = new MicAudio_();
