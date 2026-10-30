const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('========================================================');
console.log('   DaRI AI Arcade — Automated Android APK Builder');
console.log('========================================================\n');

// Detect Java and Android SDK
let javaHome = process.env.JAVA_HOME;
if (!javaHome || !fs.existsSync(javaHome) || javaHome.includes('jdk-25_windows-x64_bin')) {
  const possibleJava = [
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-25.0.0.36-hotspot'
  ];
  for (const p of possibleJava) {
    if (fs.existsSync(p)) {
      javaHome = p;
      break;
    }
  }
}

let androidHome = process.env.ANDROID_HOME;
if (!androidHome || !fs.existsSync(androidHome)) {
  const localSdk = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  if (fs.existsSync(localSdk)) {
    androidHome = localSdk;
  }
}

console.log(`[Config] JAVA_HOME:    ${javaHome || 'Not Found'}`);
console.log(`[Config] ANDROID_HOME: ${androidHome || 'Not Found'}\n`);

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  PATH: `${path.join(javaHome || '', 'bin')};${path.join(androidHome || '', 'platform-tools')};${process.env.PATH}`
};

try {
  console.log('[1/3] Syncing web assets via Capacitor...');
  execSync('npx cap sync android', { stdio: 'inherit', env });

  console.log('\n[2/3] Compiling Android APK with Gradle wrapper...');
  const androidDir = path.join(__dirname, '..', 'android');
  const gradlewCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
  execSync(`${gradlewCmd} assembleDebug`, { cwd: androidDir, stdio: 'inherit', env });

  const generatedApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  const targetApk = path.join(__dirname, '..', 'dariai-arcade-mobile.apk');

  if (fs.existsSync(generatedApk)) {
    fs.copyFileSync(generatedApk, targetApk);
    console.log('\n========================================================');
    console.log(' [SUCCESS] APK Generated Successfully!');
    console.log(` Output: ${targetApk}`);
    console.log('========================================================\n');
  } else {
    console.warn('\n[Warning] Gradle finished but APK file was not located at expected path.');
  }
} catch (error) {
  console.error('\n[Error] Build failed:', error.message);
  process.exit(1);
}
