import {VolumeManager, VolumeResult} from 'react-native-volume-manager';
import {HMLogger} from './logger';
import {Settings} from './settings';

const Logger = new HMLogger('volume');

class VolumeManager_ {
  constructor() {
    const volumeListener = VolumeManager.addVolumeListener(result => {
      // returns the current volume as a float (0-1)
      Logger.debug(`Volume changed event: ${JSON.stringify(result)}`);
      if (['music'].includes(result.type ? result.type : '')) {
        Logger.debug(`Volume changed: ${result.volume}`);
        Settings.setPlaybackVolume(Math.round(result.volume * 100) / 100).then(
          () => {},
        );
      }
    });
  }

  async getVolume(): Promise<VolumeResult> {
    const volume = await VolumeManager.getVolume();
    if (volume === undefined) {
      throw new Error('Volume is undefined');
    }
    return volume;
  }

  async setVolume(volume: number): Promise<void> {
    VolumeManager.setVolume(volume);
    Settings.setPlaybackVolume(volume).then(() => {
      Logger.debug(`Set playback volume to ${volume}`);
    });
  }
}

export const Volume = new VolumeManager_();
