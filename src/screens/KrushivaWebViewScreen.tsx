import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Linking, Alert } from 'react-native';
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import messaging from '@react-native-firebase/messaging';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestUserPermission, getFCMToken, saveFCMTokenToServer } from '../services/PushNotificationService';
import { KRUSHIVA_URL } from '../constants/app';

const AUTH_TOKEN_KEY = 'authToken';

function KrushivaWebViewScreen(): React.JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const [currentUrl, setCurrentUrl] = useState(KRUSHIVA_URL);
  const [apiToken, setApiToken] = useState<string | null>(null);

  // Use a ref so the FCM token is always available synchronously
  // inside event handlers without waiting for a re-render cycle.
  const fcmTokenRef = useRef<string | null>(null);

  // Persist & restore apiToken across app restarts
  useEffect(() => {
    const restoreToken = async () => {
      const stored = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      if (stored) {
        setApiToken(stored);
      }
    };
    restoreToken();
  }, []);

  useEffect(() => {
    const setupFCM = async () => {
      const hasPermission = await requestUserPermission();
      if (hasPermission) {
        const token = await getFCMToken();
        console.log('FCM Token on setup:', token);
        fcmTokenRef.current = token;

        // If we already have a restored apiToken, save immediately
        if (token && apiToken) {
          saveFCMTokenToServer(token, apiToken);
        }
      }
    };
    setupFCM();

    // Keep the ref in sync when the token rotates
    const unsubscribeTokenRefresh = messaging().onTokenRefresh(token => {
      console.log('FCM Token refreshed:', token);
      fcmTokenRef.current = token;
      if (apiToken) {
        saveFCMTokenToServer(token, apiToken);
      }
    });

    // Handle foreground messages
    const unsubscribeOnMessage = messaging().onMessage(async remoteMessage => {
      console.log('Foreground message received!', remoteMessage);
      Alert.alert('New Notification', remoteMessage.notification?.body || 'You have a new message.');
    });

    // Handle notification tap when app is in background
    messaging().onNotificationOpenedApp(remoteMessage => {
      console.log('Notification caused app to open from background state:', remoteMessage.data);
      handleNotificationTap(remoteMessage.data);
    });

    // Handle notification tap when app was quit
    messaging()
      .getInitialNotification()
      .then(remoteMessage => {
        if (remoteMessage) {
          console.log('Notification caused app to open from quit state:', remoteMessage.data);
          handleNotificationTap(remoteMessage.data);
        }
      });

    return () => {
      unsubscribeTokenRefresh();
      unsubscribeOnMessage();
    };
  }, [apiToken]);

  const handleNotificationTap = (data: any) => {
    if (!data) return;
    const targetUrl = data.edit_url || data.url;
    if (targetUrl) {
      setCurrentUrl(targetUrl);
    }
  };

  const handleWebViewMessage = async (event: WebViewMessageEvent) => {
    let data;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }

    if (!data || !data.type) return;

    switch (data.type) {
      case 'LOGIN_SUCCESS':
        console.log('✓ User logged in via WebView:', data.user);
        if (data.token) {
          // 1. Update state and persist to storage
          setApiToken(data.token);
          await AsyncStorage.setItem(AUTH_TOKEN_KEY, data.token);

          // 2. Send FCM token to backend immediately using the ref —
          //    no need to wait for a re-render cycle.
          if (fcmTokenRef.current) {
            saveFCMTokenToServer(fcmTokenRef.current, data.token);
          }
        }
        break;

      case 'LOGOUT':
        console.log('✓ User logged out via WebView');
        setApiToken(null);
        await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
        break;

      case 'FCM_TOKEN_SAVED':
        console.log('✓ FCM token confirmed saved by backend');
        break;

      case 'inventarybolt_estimate_pdf':
        if (data.download_url) {
          Linking.openURL(data.download_url).catch(err =>
            console.error("Couldn't load page", err)
          );
        }
        break;

      default:
        break;
    }
  };

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ uri: currentUrl }}
        style={styles.webView}
        onMessage={handleWebViewMessage}
        javaScriptEnabled={true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  webView: {
    flex: 1,
  },
});

export default KrushivaWebViewScreen;
