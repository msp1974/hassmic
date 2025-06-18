import AsyncStorage from '@react-native-async-storage/async-storage';
import {CheyenneSocket} from './cheyenne';
import {HMLogger} from './logger';
import {NativeManager} from './nativemgr';
import {Settings} from './settings';
import {STORAGE_KEY_RUN_BACKGROUND_TASK} from './constants';
import {WyomingServer} from './wyoming';
import {ZeroconfManager} from './zeroconf';
import {MicAudio} from './mic';

// Convenience type for a generic callback
type CallbackType<T> = (s: T) => void;

export type TaskStatus = {
  enabled: boolean;
  state: TaskState;
};

export enum TaskState {
  // no info
  UNKNOWN,

  // task tried to start but failed
  FAILED,

  // task is running
  RUNNING,

  // task is not running (on purpose)
  STOPPED,
}

const Logger = new HMLogger('backgroundtask.ts');

class BackgroundTaskManager_ {
  // manage the background task
  private _isTaskEnabled: boolean = false;
  private _taskState: TaskState = TaskState.UNKNOWN;
  // callback for when the task state changes
  private _taskStatusCallback: CallbackType<TaskStatus> = status => {};

  // callback setter
  setTaskStateCallback = (f: CallbackType<TaskStatus> | null) => {
    if (f) {
      this._taskStatusCallback = f;
    } else {
      this._taskStatusCallback = (status: TaskStatus) => {};
    }
  };

  private _notifyStatusChange = (): void => {
    this._taskStatusCallback({
      enabled: this._isTaskEnabled,
      state: this._taskState,
    });
  };

  private _setTaskState = (state: TaskState) => {
    if (this._taskState != state) {
      this._taskState = state;
      this._notifyStatusChange();
    }
  };

  // track enable state
  isEnabled: Promise<boolean> = new Promise<boolean>((resolve, fail) => {
    (async () => {
      let en_str: string = '';
      try {
        // keep the typechecker happy
        let from_storage: string | number[] | null = await AsyncStorage.getItem(
          STORAGE_KEY_RUN_BACKGROUND_TASK,
        );
        if (from_storage) {
          en_str = from_storage?.toString();
        }
      } catch (e) {
        Logger.error(`Error getting task enable state: ${e}`);
        fail(e);
      }

      let en: boolean = en_str === 'true';
      if (en_str === null) {
        Logger.debug('No enable state found. Setting to false.');
        en = false;
      }

      resolve(en);
    })();
  });

  // enable or disable the task
  setEnabled = (enable: boolean) => {
    (async () => {
      try {
        await AsyncStorage.setItem(
          STORAGE_KEY_RUN_BACKGROUND_TASK,
          enable ? 'true' : 'false',
        );
      } catch (e) {
        Logger.error(`Error saving enable state: ${e}`);
      }
      this._isTaskEnabled = enable;
      this.isEnabled = new Promise<boolean>(resolve => resolve(enable));
      this._notifyStatusChange();
    })().then(() => {});
  };

  // actually run the task
  run_fn = async (taskData: any) => {
    if (this._taskState == TaskState.RUNNING) {
      Logger.error('Background task is already running; not starting again!');
      return;
    }

    await NativeManager.waitForReady();
    await Settings.waitForReady();

    const shouldRun = await this.isEnabled;

    if (!shouldRun) {
      Logger.info('Not running background task; is disabled');
      this._setTaskState(TaskState.STOPPED);
      NativeManager.killService();
      return;
    }

    Logger.info('Started background task');
    const shouldStop = new Promise<void>(resolve => {
      this.stop_fn = resolve;
    });

    if (!(await MicAudio.checkPermissions())) {
      Logger.error('no permission; bailing');
      this._setTaskState(TaskState.FAILED);
      return;
    }
    // native event listeners
    await CheyenneSocket.startServer();
    Logger.info('Started cheyenne server');

    await WyomingServer.startServer();
    Logger.info('Started wyoming server');

    await ZeroconfManager.StartZeroconf();

    await MicAudio.init();

    this._setTaskState(TaskState.RUNNING);

    Logger.info('Background task running, awaiting stop signal');
    await shouldStop;
    Logger.info('Background task got stop signal, stopping');
    MicAudio.stop();
    await ZeroconfManager.StopZeroconf();
    await WyomingServer.stopServer();
    await CheyenneSocket.stopServer();
    NativeManager.killService();
    this._setTaskState(TaskState.STOPPED);
  };

  // stop_fun is set by run() to the resolver on a promise. run() then runs
  // until that promise is fulfilled.
  private stop_fn: (() => void) | null = null;

  // stop the current run by resolving the promise using stop_fn.
  stop = () => {
    if (this._taskState != TaskState.RUNNING) {
      Logger.warning(
        'Called stop() on background task, but it is not running; ignoring',
      );
      return;
    }
    if (this.stop_fn) {
      this.stop_fn();
    } else {
      Logger.error(
        "Called stop() on background task, but it doesn't appear to be running",
      );
    }
  };

  // kill any existing instance of the task
  kill = () => {
    NativeManager.killService();
  };

  // start the task
  run = () => {
    if (this._taskState == TaskState.RUNNING) {
      Logger.error('Background task is already running; not starting again!');
      return;
    }
    NativeManager.runService();
  };
}

export const BackgroundTaskManager = new BackgroundTaskManager_();
