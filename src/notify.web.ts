/** The PC window is open while it is used and shows everything itself, so it raises no notifications. */
export const CONNECTION_KEY = 'studio-connection';
export const startNotifications = async () => false;
export const stopNotifications = async () => undefined;
