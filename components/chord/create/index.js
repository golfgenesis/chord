import React, { useState } from 'react';
import {
  Dialog,
  Button,
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Slide,
  Grid,
  InputAdornment,
  CircularProgress,
  Radio,
  RadioGroup,
  FormControlLabel,
  FormControl,
  Snackbar,
  Fab,
  Backdrop
} from '@material-ui/core';
import CloseIcon from '@material-ui/icons/Close';
import TextFormatIcon from '@material-ui/icons/TextFormat';
import StarBorderIcon from '@material-ui/icons/StarBorder';
import QueryBuilderIcon from '@material-ui/icons/QueryBuilder';
import AddIcon from '@material-ui/icons/Add';
import RefreshIcon from '@material-ui/icons/Refresh';
import _ from 'lodash';
import { db, storage } from '../../firebase'
import moment from 'moment'
import { ValidatorForm, TextValidator } from "react-material-ui-form-validator"
import useStyles from '../styles';
import globalStyles from '../../styles';
import SingleImage from './singleImage'
import MultipleImage from './multipleImage'
import URLImage from './urlImage'
import Modal from './../../modal'

const Transition = React.forwardRef(function Transition(props, ref) {
  return <Slide direction="right" ref={ref} {...props} />;
});

export default function Create(props) {
  const { getSongFromFirebase } = props
  const classes = useStyles();
  const classesGlobal = globalStyles();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [alert, setAlert] = useState(false);
  const [typeUpload, setTypeUpload] = useState("singleImage");
  const [urlImage, setUrlImage] = useState("");
  const [name, setName] = useState("");
  const [artist, setArtist] = useState("");
  const [tempo, setTempo] = useState("");
  const [files, setFiles] = useState([]);

  const handleClickOpen = () => {
    setOpen(true);
  }

  const handleDownload = () => {
    getSongFromFirebase()
  }

  const handleClose = () => {
    setOpen(false)
    setLoading(false)
    setTypeUpload("singleImage")
    setUrlImage("")
    setName("")
    setArtist("")
    setTempo("")
    setFiles([])
    getSongFromFirebase()
  }

  const handleChangeRadio = e => {
    setTypeUpload(e.target.value);
    setFiles([])
  };

  const handleSubmit = () => {
    setLoading(true)
    if (typeUpload === "singleImage") {
      if (!_.isEmpty(files)) {
        UploadImage(files)
      } else {
        setLoading(false)
        setAlert("กรุณาใส่รูปภาพให้ถูกต้อง")
      }
    } else if (typeUpload === "multipleImage") {
      if (!_.isEmpty(files)) {
        UploadImage(files)
      } else {
        setLoading(false)
        setAlert("กรุณาใส่รูปภาพให้ถูกต้อง")
      }
    } else {
      createChord()
    }
  }

  const UploadImage = (files) => {
    files.forEach(async (file, index) => {
      const imageName = moment().unix() + "_" + (index + 1)
      const filename = file.name.split('.').slice(0, -1).join('.')
      try {
        const storageRef = storage.ref();
        const fileRef = storageRef.child(`song/${imageName}`);
        const uploadTaskSnapshot = await fileRef.put(file);
        const downloadURL = await uploadTaskSnapshot.ref.getDownloadURL();
        typeUpload === "multipleImage"
          ? createChord(downloadURL, imageName, filename)
          : createChord(downloadURL, imageName);
        (index + 1) === files.length && handleClose()
      } catch (error) {
        console.log(error);
      }
    })
  }

  const createChord = async (downloadURL, imageName, filename) => {
    let chord_id = imageName || moment().unix() + "_0"
    let image = typeUpload === "urlImage" ? urlImage : downloadURL
    await db.collection("song").doc(chord_id).set({
      chord_id: chord_id,
      image: image,
      name: filename || name,
      artist: artist,
      tempo: tempo,
      dateCreate: moment().format()
    })
  }

  return (
    <div>
      <Backdrop open={loading} className={classesGlobal.backdrop}>
        <CircularProgress color="inherit" />
      </Backdrop>
      <Fab size="small" color="secondary" className={classes.fabButton} onClick={handleClickOpen}>
        <AddIcon color="primary" />
      </Fab>
      <Fab size="small" color="secondary" className={classes.fabButton2} onClick={handleDownload}>
        <RefreshIcon color="primary" />
      </Fab>
      <Modal action={() => setAlert()} {...alert} />
      <Snackbar
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'center',
        }}
        open={alert ? true : false}
        autoHideDuration={3000}
        onClose={() => setAlert(false)}
        message={alert}
        action={
          <React.Fragment>
            <IconButton size="small" aria-label="close" color="inherit" onClick={() => setAlert(false)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </React.Fragment>
        }
      />
      <Dialog className={classes.wrapper} fullScreen open={open} onClose={handleClose} TransitionComponent={Transition}>
        <ValidatorForm onSubmit={handleSubmit} onError={err => { console.log(err) }}>
          <AppBar className={classes.appBar}>
            <Toolbar>
              <IconButton edge="start" color="inherit" onClick={handleClose} aria-label="close">
                <CloseIcon />
              </IconButton>
              <Typography variant="h6" className={classes.title}>
                เพิ่มคอร์ด
            </Typography>
              {loading
                ? <CircularProgress color="inherit" size={20} />
                : <Button variant="outlined" color="secondary" autoFocus color="inherit" type="submit">
                  บันทึก
                 </Button>
              }
            </Toolbar>
          </AppBar>
          <Grid container>
            <Grid item xs={12} className={classes.grid}>
              <Typography className={classesGlobal.py1}>เลือกรูปแบบการอัพโหลด</Typography>
              <FormControl component="fieldset">
                <RadioGroup row aria-label="position" name="position" onChange={handleChangeRadio} value={typeUpload}>
                  <FormControlLabel
                    value="singleImage"
                    control={<Radio color="primary" />}
                    label="เพิ่มเพลง" />
                  <FormControlLabel
                    value="multipleImage"
                    control={<Radio color="primary" />}
                    label="อัพโหลดเพลง" />
                  <FormControlLabel
                    value="urlImage"
                    control={<Radio color="primary" />}
                    label="เพิ่มจาก URL" />
                </RadioGroup>
              </FormControl>
            </Grid>
            <Grid item xs={12} className={classes.grid}>
              {typeUpload === "urlImage"
                ? <URLImage
                  urlImage={urlImage}
                  setUrlImage={setUrlImage} />
                : typeUpload === "singleImage"
                  ? <SingleImage
                    files={files}
                    setFiles={setFiles}
                    setAlert={setAlert} />
                  : <MultipleImage
                    files={files}
                    setFiles={setFiles}
                    setAlert={setAlert} />
              }
            </Grid>
            {typeUpload !== "multipleImage" &&
              <>
                <Grid item xs={12} className={classes.grid}>
                  <TextValidator
                    fullWidth
                    label="ชื่อเพลง"
                    name="name"
                    autoComplete="off"
                    onChange={e => setName(e.target.value)}
                    placeholder="กรุณาใส่ชื่อเพลง"
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <TextFormatIcon color="primary" />
                        </InputAdornment>
                      ),
                    }}
                    value={name}
                    validators={["required"]}
                    errorMessages={["กรุณากรอกข้อมูล"]} />
                </Grid>
                <Grid item xs={12} className={classes.grid}>
                  <TextValidator
                    fullWidth
                    label="ศิลปิน"
                    name="artist"
                    autoComplete="off"
                    onChange={e => setArtist(e.target.value)}
                    placeholder="กรุณาใส่ชื่อศิลปิน"
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <StarBorderIcon color="primary" />
                        </InputAdornment>
                      ),
                    }}
                    value={artist} />
                </Grid>
                <Grid item xs={12} className={classes.grid}>
                  <TextValidator
                    fullWidth
                    label="เมโทนอม"
                    name="tempo"
                    autoComplete="off"
                    onChange={e => setTempo(e.target.value)}
                    placeholder="กรุณาใส่ค่าเมโทนอม"
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <QueryBuilderIcon color="primary" />
                        </InputAdornment>
                      ),
                    }}
                    value={tempo}
                    validators={["isFloat", 'maxFloat:999.99']}
                    errorMessages={["ค่าเมโทนอมไม่ถูกต้อง", "ค่าเมโทนอมต้องไม่เกิน 999.99"]} />
                </Grid>
              </>
            }
          </Grid>
        </ValidatorForm>
      </Dialog>
    </div>
  );
}