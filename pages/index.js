import { useState, useEffect } from "react"
import _ from "lodash"
import { db, firebase } from './../components/firebase'
import Chordlists from '../components/chord'
import Create from '../components/chord/create'
import { LoadingContentChord } from '../components/loading/content'
import localforage from 'localforage'

export default function Home() {
  const [user, setUser] = useState()
  const [song, setSong] = useState([])

  useEffect(() => {
    firebase.auth().onAuthStateChanged(user => setUser(!!user))
    getSong()
  }, [user])

  const getSong = () => {
    localforage.getItem('song')
      .then(value => {
        !_.isEmpty(value) ? setSong(value) : getSongFromFirebase()
      })
      .catch(err => {
        console.log(err)
      })
  }

  const getSongFromFirebase = () => {
    db.collection("song")
      .orderBy("dateCreate", "desc")
      .get()
      .then(function (querySnapshot) {
        let data = []
        querySnapshot.forEach(function (doc) {
          data.push(doc.data());
        });
        localforage.setItem('song', data)
          .then(function () {
            return localforage.getItem('song');
          }).then(value => {
            setSong(value)
          }).catch(err => {
            console.log(err)
          });
      });
  }

  return (
    <React.Fragment>
      {!_.isEmpty(song)
        ? <Chordlists song={song} />
        : <LoadingContentChord />
      }
      <Create getSongFromFirebase={getSongFromFirebase} />
    </React.Fragment>
  )
}