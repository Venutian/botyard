import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useState } from 'react';

export const CAN_TALK = true;

/** Turns speech into text with the phone's own engine. `onText` gets each better guess while talking. */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', () => setListening(false));
  useSpeechRecognitionEvent('result', (event) => {
    const text = event.results[0]?.transcript;
    if (text) onText(text);
  });
  const toggle = useCallback(async () => {
    if (listening) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (granted) ExpoSpeechRecognitionModule.start({ lang: 'en-US', interimResults: true, continuous: false });
  }, [listening]);
  return { listening, toggle };
}

const plain = (text: string) => text.replace(/\|[-:\s|]+\|/g, ' ').replace(/[*`#|_]/g, ' ').replace(/\s+/g, ' ').trim();

export function speak(text: string) {
  Speech.stop();
  Speech.speak(plain(text));
}

export const stopSpeaking = () => Speech.stop();
