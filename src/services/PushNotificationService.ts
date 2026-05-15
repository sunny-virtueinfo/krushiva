import messaging from '@react-native-firebase/messaging';
import { Platform, Alert } from 'react-native';

export const requestUserPermission = async () => {
  if (Platform.OS === 'ios') {
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;
    return enabled;
  } else if (Platform.OS === 'android') {
    // Android 13+ requires explicit permission
    if (Platform.Version >= 33) {
      const authStatus = await messaging().requestPermission();
      return (
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL
      );
    }
    return true; // Auto-granted on older Android versions if in manifest
  }
  return false;
};

export const getFCMToken = async () => {
  try {
    // iOS requires device registration for remote messages before getToken()
    if (Platform.OS === 'ios') {
      await messaging().registerDeviceForRemoteMessages();
    }
    const token = await messaging().getToken();
    return token;
  } catch (error) {
    console.error('Error getting FCM token:', error);
    return null;
  }
};

export const saveFCMTokenToServer = async (token: string, apiToken: string) => {
  try {
    const response = await fetch('https://krushiva.com/api/fcm/save-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        token: token,
        platform: Platform.OS,
      }),
    });
    const result = await response.json();
    console.log('Save FCM token result:', result);
  } catch (error) {
    console.error('Error saving FCM token:', error);
  }
};
