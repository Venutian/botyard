import { Alert, Platform } from 'react-native';

/** Alert does nothing in the PC window, so on the web these fall back to the browser's own dialogs. */
export function ask(title: string, message: string, label: string, onYes: () => void, cancel = 'Cancel') {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [{ text: cancel, style: 'cancel' }, { text: label, style: 'destructive', onPress: onYes }]);
}

export function tell(title: string, message: string) {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}
