import React from 'react';
import { makeStyles } from '@material-ui/core/styles';
import Dialog from '@material-ui/core/Dialog';
import AppBar from '@material-ui/core/AppBar';
import Toolbar from '@material-ui/core/Toolbar';
import IconButton from '@material-ui/core/IconButton';
import Typography from '@material-ui/core/Typography';
import CloseIcon from '@material-ui/icons/Close';
import Slide from '@material-ui/core/Slide';

const useStyles = makeStyles((theme) => ({
  appBar: {
    position: 'relative',
  },
  title: {
    marginLeft: theme.spacing(2),
    flex: 1,
    color: "white"
  },
  image: {
    marginTop: theme.spacing(2),
    maxWidth: "100%",
    height: "auto"
  }
}));

const Transition = React.forwardRef(function Transition(props, ref) {
  return <Slide direction="right" ref={ref} {...props} />;
});

export default function FullScreenDialog(props) {
  const { data, open, setIsOpen } = props
  const classes = useStyles();

  return (
    <div>
      <Dialog fullScreen open={open} onClose={() => setIsOpen(false)} TransitionComponent={Transition}>
        <AppBar className={classes.appBar}>
          <Toolbar>
            <IconButton edge="start" color="inherit" onClick={() => setIsOpen(false)} aria-label="close">
              <CloseIcon />
            </IconButton>
            <Typography variant="h6" className={classes.title}>
              {data.name + " - " + data.artist}
            </Typography>
            {data.tempo &&
              <div>
                Tempo : {data.tempo}
              </div>
            }
          </Toolbar>
        </AppBar>
        <div className={classes.image}>
          <img src={data.image} width="100%" />
        </div>
      </Dialog>
    </div>
  );
}
