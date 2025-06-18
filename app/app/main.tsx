import {
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StyleSheet,
  StatusBar,
  Switch,
  Text,
  View,
} from "react-native";
import { APP_VERSION } from "./constants";
import { BackgroundTaskManager, TaskState, TaskStatus } from "./backgroundtask";
import { CheyenneSocket } from "./cheyenne";
import { NetworkInfo } from "react-native-network-info";
import { WyomingServer } from "./wyoming";
import { Settings } from "./settings";
import { useState, useEffect } from "react";
import { SavedSettings } from "./proto/hassmic";
import { MicAudio } from "./mic";

const ANDROID_VERSION: number = +Platform.Version;

export default function Index() {
  const [hasAudioPermission, setHasAudioPermission] = useState(false);
  const [hasNotificationPermission, setHasNotificationPermission] = useState<boolean | null>(false);
  const [isCheyenneConnected, setIsCheyenneConnected] = useState(false);
  const [isWyomingConnected, setIsWyomingConnected] = useState(false);
  const [isBackgroundTaskEnabled, setBackgroundTaskEnabled] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(TaskState.UNKNOWN);
  const [localIP, setLocalIP] = useState<string | null>("");
  const [uuid, setUUID] = useState("");
  const [micGain, setMicGain] = useState(1);
  const [wakewordSound, setWakewordSound] = useState("");

  
  // check notification permission silently
  const checkNotificationPermission = async (): Promise<boolean | null> => {
    if (ANDROID_VERSION < 33) {
      // notification permission does not exist before API 33
      setHasNotificationPermission(null);
      return null;
    }
    const notify_ok = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    setHasNotificationPermission(notify_ok);
    return notify_ok;
  };

  // ask for permissions, if need
  const requestPermissions = async () => {
    const audio_ok = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    );
    setHasAudioPermission(audio_ok == PermissionsAndroid.RESULTS.GRANTED);
    console.log(`Audio permission: ${audio_ok}`);

    const notif_ok =
      ANDROID_VERSION < 33
        ? null
        : await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
          );
    setHasNotificationPermission(
      ANDROID_VERSION < 33
        ? null
        : notif_ok == PermissionsAndroid.RESULTS.GRANTED
    );
    console.log(`Notify permission: ${notif_ok}`);
  };

  const settingsUpdated = async (newSettings: SavedSettings) => {
    setUUID(newSettings.hassmicUuid);
    setMicGain(newSettings.micGain || 1);
    setWakewordSound(newSettings.wakewordSound || "");
  };

  // useEffect(..., []) means this code will be called once on component mount
  // (or twice in dev mode, maybe?). Do the setup stuff here.
  useEffect(() => {
    CheyenneSocket.setConnectionStateCallback(setIsCheyenneConnected);
    WyomingServer.setConnectionStateCallback(setIsWyomingConnected);

    NetworkInfo.getIPV4Address().then(setLocalIP);
    Settings.getHMUUID().then(setUUID);
    BackgroundTaskManager.isEnabled.then(setBackgroundTaskEnabled);

    Settings.registerSettingsChangedCallback(settingsUpdated);

    // kill any existing instance of the background task (ie, task running even
    // though the app was killed)
    BackgroundTaskManager.kill();

    BackgroundTaskManager.setTaskStateCallback((status: TaskStatus) => {
      if (status.enabled !== isBackgroundTaskEnabled) {
        setBackgroundTaskEnabled(status.enabled);
      }
      if (status.state !== backgroundTaskState) {
        setBackgroundTaskState(status.state);
      }
    });

    
    // checkAudioPermission and checkNotificationPermission should set their
    // state state values, but in useEffect(..., []) that doesn't work. Using
    // .then() solves that problem.
    MicAudio.checkPermissions().then((ok) => {
      setHasAudioPermission(ok);
    });
    checkNotificationPermission().then((ok) => {
      setHasNotificationPermission(ok);
    });


    // Inititiate mic gain and wakeword sound from settings on startup
    Settings.getMicGain().then((gain) => {
      setMicGain(gain);
    });
    Settings.getWakewordSound().then((sound) => {
      setWakewordSound(sound);
    });

  }, []);

  // when background task is toggled on or off, start or stop it accordingly.
  useEffect(() => {
    if (isBackgroundTaskEnabled) {
      BackgroundTaskManager.run();
    } else {
      BackgroundTaskManager.stop();
    }
  }, [isBackgroundTaskEnabled]);

  const Separator = () => (
    <View
      style={{
        marginVertical: 8,
        borderBottomColor: "#737373",
        borderBottomWidth: StyleSheet.hairlineWidth,
      }}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar backgroundColor="#000000" />
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <>
          {hasAudioPermission ? null : (
            <View>
              <Button title="Get Permissions" onPress={requestPermissions} />
            </View>
          )}
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
            }}
          >
            <Text
              style={{
                fontSize: 24,
              }}
            >
              Enable running in background:{" "}
            </Text>
            <Switch
              onValueChange={BackgroundTaskManager.setEnabled}
              value={isBackgroundTaskEnabled}
              disabled={!hasAudioPermission}
            />
          </View>
          <View
            style={{
              borderBottomColor: "black",
              borderBottomWidth: 1,
              height: 10,
            }}
          />
          <Text>
            Background Task: {isBackgroundTaskEnabled ? "enabled" : "disabled"}{" "}
            and{" "}
            {backgroundTaskState == TaskState.RUNNING
              ? "running"
              : "not running"}
          </Text>
          <Text>Local IP: {localIP}</Text>
          <Text>Device Unique ID: {uuid.slice(0, 8)}</Text>
          <Text>Wyoming Connected: {isWyomingConnected ? "yes" : "no"}</Text>
          <Text>
            HassMic Integration Connected: {isCheyenneConnected ? "yes" : "no"}
          </Text>
          <Text>
            Permission to record audio: {hasAudioPermission ? "yes" : "no"}
          </Text>
          <Text>
            Permission to show notification:{" "}
            {hasNotificationPermission === null
              ? "not required"
              : hasNotificationPermission
              ? "yes"
              : "no"}
          </Text>
          <Text>Version {APP_VERSION}</Text>
          <Separator />
          <Text>Microphone Gain: {micGain}</Text>
          <Text>Wakeword Sound: {wakewordSound === ''? 'None':wakewordSound}</Text>
        </>
      </View>
    </SafeAreaView>
  );

  
}
