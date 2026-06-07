// 探測：未經 App Check 的匿名讀取是否能成功（決定 Playwright 比對策略）
import { initializeApp } from 'firebase/app'
import { getFirestore, doc, getDoc } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAkR6ZbLuTbmVsItNP42sH1-RKQs0k8Njo',
  authDomain: 'bol-line-bot-3.firebaseapp.com',
  projectId: 'bol-line-bot-3',
  storageBucket: 'bol-line-bot-3.firebasestorage.app',
  messagingSenderId: '651905438882',
  appId: '1:651905438882:web:bc3b2087925ce50c4db3fb',
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

try {
  const snap = await getDoc(doc(db, '_config', 'serve-list'))
  if (snap.exists()) {
    const serves = snap.data().serves || []
    console.log('READ_OK serve-list serves=', serves.map((s) => `${s.id}:${s.name}`).join(', '))
  } else {
    console.log('READ_OK but serve-list missing')
  }
  process.exit(0)
} catch (e) {
  console.log('READ_FAIL', e?.code || '', e?.message || String(e))
  process.exit(1)
}
