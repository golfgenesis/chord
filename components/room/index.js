import React from 'react';
import {
  makeStyles,
  Dialog,
  Button,
  AppBar,
  Toolbar,
  IconButton,
  Typography,
  Slide,
  Grid,
  InputAdornment
} from '@material-ui/core';
import CloseIcon from '@material-ui/icons/Close';
import TextFormatIcon from '@material-ui/icons/TextFormat';
import _ from 'lodash';
import { db } from './../firebase'
import moment from 'moment'
import { ValidatorForm, TextValidator } from "react-material-ui-form-validator"

const useStyles = makeStyles((theme) => ({
  appBar: {
    position: 'relative',
  },
  title: {
    marginLeft: theme.spacing(2),
    flex: 1,
  },
}));

const Transition = React.forwardRef(function Transition(props, ref) {
  return <Slide direction="up" ref={ref} {...props} />;
});

export default function FullScreenDialog() {
  const classes = useStyles();
  const [open, setOpen] = React.useState(false);
  const [room, setRoom] = React.useState("");

  const handleClickOpen = () => {
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleSubmit = () => {
    createRoom()
  };

  const createRoom = () => {
    db.collection("room").add({
      rid: moment().unix(),
      name: room,
      search: "",
      dateCreate: moment().format(),
    })
      .then((doc) => {
        handleClose()
      })
      .catch((error) => {
        console.error(error)
      });
  }

  return (
    <div>
      <Button variant="outlined" color="primary" onClick={handleClickOpen}>
        Open full-screen dialog
      </Button>
      <Dialog fullScreen open={open} onClose={handleClose} TransitionComponent={Transition}>
        <ValidatorForm onSubmit={handleSubmit} onError={err => { console.log(err) }}>
          <AppBar className={classes.appBar}>
            <Toolbar>
              <IconButton edge="start" color="inherit" onClick={handleClose} aria-label="close">
                <CloseIcon />
              </IconButton>
              <Typography variant="h6" className={classes.title}>
                Sound
            </Typography>
              <Button type="submit" autoFocus color="inherit" onClick={handleClose}>
                save
            </Button>
            </Toolbar>
          </AppBar>
          <Grid container>
            <Grid item xs={12} className={classes.grid}>
              <TextValidator
                fullWidth
                label="ชื่อห้อง"
                name="room"
                autoComplete="off"
                onChange={e => setRoom(e.target.value)}
                placeholder="กรุณาใส่ชื่อห้อง"
                InputProps={{
                  startAdornment: (
                    <InputAdornment position="start">
                      <TextFormatIcon color="primary" />
                    </InputAdornment>
                  ),
                }}
                value={room}
                validators={["required"]}
                errorMessages={["กรุณากรอกข้อมูล"]} />
            </Grid>
          </Grid>
        </ValidatorForm>
      </Dialog>
    </div>
  );
}