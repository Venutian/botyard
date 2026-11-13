# The Botyard phone app

This is the phone app for Botyard, written with Expo and React Native. It shows what your crew of AI
bots is doing, lets you answer their questions, give them jobs, and change the studio from your phone.

The app talks to one thing only: the phone door of a Botyard running on your own computer. It has no
server of its own and no address built in. It learns your computer's address when you pair it, and
any other way in (a tunnel, an edge address) from the door's `/v1/hello`. Keys and sign-ins stay on
the computer; the phone holds one device key, in the system's secure storage.

The code is in the folder above this one (`App.tsx`, `app.json`) and in this folder:

- `api.ts`, `connection.ts`: every call to the door, and the ways to reach it
- `screens/`: one file per screen
- `ui/`, `theme/`, `mascot/`: the shared parts, the Plates look by day and night, and each bot's badge, drawn from its role and look
- `preview.ts`: made-up sample data, used only by the web preview

## Run it

You need Node 20 or newer. From the folder above this one:

```
npm install
npm start
```

Scan the code with Expo Go, or press `a` for an Android emulator. Voice input and background
notifications need a real build (below); the rest works in Expo Go.

To look at the design in a browser with sample data and no Botyard running:

```
npm run web
```

Pair the app from the computer Botyard runs on with `npm run pair`, which shows a code to scan. Or
type the computer's address and the pairing token on the app's first screen.

Check the types with `npm run typecheck`.

## Build your own Android APK, with no account

You need a JDK (17) and the Android SDK. Then:

```
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```

The APK is at `android/app/build/outputs/apk/release/app-release.apk`. Expo's template signs a
release build with the debug key it sets up, so this works as it is. That key is fine for your own
phone. It is not for an app you hand to other people: anyone can sign with a debug key.

### Sign with your own key

Make a keystore once and keep it safe. An update must be signed with the same key as the app it
replaces, so a lost keystore means installing fresh.

```
keytool -genkeypair -v -storetype PKCS12 -keystore my-release.keystore -alias botyard -keyalg RSA -keysize 2048 -validity 10000
```

Put the file in `android/app/`. In `android/gradle.properties` (or better, in
`~/.gradle/gradle.properties`, outside the project) add:

```
BOTYARD_STORE_FILE=my-release.keystore
BOTYARD_STORE_PASSWORD=your store password
BOTYARD_KEY_ALIAS=botyard
BOTYARD_KEY_PASSWORD=your key password
```

In `android/app/build.gradle`, add a `release` entry to `signingConfigs` and point the release build
at it:

```
signingConfigs {
    release {
        storeFile file(BOTYARD_STORE_FILE)
        storePassword BOTYARD_STORE_PASSWORD
        keyAlias BOTYARD_KEY_ALIAS
        keyPassword BOTYARD_KEY_PASSWORD
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
    }
}
```

Never commit a keystore or its passwords. The `android/` and `ios/` folders, `*.jks`, `*.keystore`
and `credentials.json` are in `.gitignore` for that reason. `expo prebuild --clean` makes `android/`
again from scratch, so keep the keystore's only copy somewhere else.

If you put the app out under your own name, change `android.package` in `app.json` to an id that is
yours before you build.

## Or build with your own Expo account

```
npm install -g eas-cli
eas login
eas init
npm run build:apk
```

`eas init` makes a project in your account and writes its id into `app.json`. The `preview` profile
in `eas.json` builds an APK and reads the signing key from your computer: put your keystore's
details in a `credentials.json` beside `app.json`, as Expo's guide to local credentials describes.
To let Expo make and keep the key instead, remove the `credentialsSource` line from `eas.json`.

## What the door tells the app about a bot

The app knows no bot by name. Each bot the door lists may carry a `role` (`lead`, `builder`,
`checker`, `reviewer`, `ruler`, `researcher` or `general`) and a `look` with a `colour`. The lead is
the bot the phone chats with. A bot's drawn face takes its shape from its role and its colour from
`look.colour`, or from a fixed set of eight when the studio gave none. An older door that says
neither still works: every bot is `general`, and any of them can be chatted with.
