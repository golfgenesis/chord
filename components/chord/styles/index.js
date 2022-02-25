import { makeStyles } from '@material-ui/core';

const styles = makeStyles((theme) => ({
  wrapper: {
    backgroundColor: "#18191A"
  },
  appBar: {
    position: 'relative',
  },
  title: {
    marginLeft: theme.spacing(2),
    flex: 1,
    color: "white"
  },
  grid: {
    padding: theme.spacing(2),
  },
  fileuploadWrapper: {
    padding: theme.spacing(2),
    marginTop: 56,
    marginBottom: 51,
  },
  uploadBox: {
    textAlign: 'center',
  },
  dropbox: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '50px 0px 40px 0px',
    borderWidth: 2,
    borderRadius: 2,
    borderColor: '#eeeeee',
    borderStyle: 'dashed',
    backgroundColor: '#fafafa',
    color: '#bdbdbd',
    outline: 'none',
    transition: 'border .24s ease-in-out',
  },
  imageUpload: {
    maxWidth: '100%',
    maxHeight: 300,
  },
  search: {
    backgroundColor: "#242526",
    padding: theme.spacing(10, 0),
    marginBottom: 10
  },
  titleSong: {
    fontSize: "max(5vw, 30px)",
    color: "white",
    paddingBottom: theme.spacing(8),
  },
  fabButton: {
    position: 'absolute',
    zIndex: 1,
    left: 20,
    top: 20,
    color: "white"
  },
  fabButton2: {
    position: 'absolute',
    zIndex: 1,
    right: 20,
    top: 20,
    color: "white"
  },
  thumbsContainer: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap'
  },
  thumb: {
    display: 'inline-flex',
    borderRadius: 2,
    border: '1px solid #eaeaea',
    margin: 3,
    width: 100,
    height: 100,
    padding: 4,
    boxSizing: 'border-box'
  },
  thumbInner: {
    display: 'flex',
    minWidth: 0,
    overflow: 'hidden'
  },
  img: {
    display: 'block',
    width: 'auto',
    height: '100%'
  }
}));

export default styles