import * as firebase from 'firebase/app';
import 'firebase/firestore';
import 'firebase/storage';
import 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyDU8I1Yf97zA9K0rjEqgDPFBpfspX9gxEM",
  authDomain: "ichordapp.web.app",
  projectId: "ichordapp",
  storageBucket: "ichordapp.appspot.com",
  messagingSenderId: "617456190689"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
  var db = firebase.firestore();
  var storage = firebase.storage();
}

export { firebase, db, storage }