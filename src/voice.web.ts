/** Chromium in the PC window has no speech engine of its own, so voice stays on the phone. */
export const CAN_TALK = false;
export const useDictation = (_onText: (text: string) => void) => ({ listening: false, toggle: async () => undefined });
export const speak = (_text: string) => undefined;
export const stopSpeaking = () => undefined;
