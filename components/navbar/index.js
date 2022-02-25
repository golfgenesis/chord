import {
  Container,
  AppBar,
  Toolbar,
  Typography,
  makeStyles,
  ListItem,
  ListItemAvatar,
  Avatar,
  ListItemText,
  Popover,
  List,
  Divider,
  ListItemIcon,
} from "@material-ui/core";
import { useRouter } from "next/router";
import Link from "next/link";
import ExitToAppIcon from '@material-ui/icons/ExitToApp';
import HomeIcon from '@material-ui/icons/Home';
import AccountBoxIcon from '@material-ui/icons/AccountBox';
import PeopleAltIcon from '@material-ui/icons/PeopleAlt';
import DirectionsRunIcon from '@material-ui/icons/DirectionsRun';
import axios from "axios"
import styles from "./../../theme/style.js"

const useStylesGlobal = makeStyles(styles)
const useStylePivate = makeStyles(theme => ({
  appBar: {
    boxShadow: "none",
    background: 'transparent'
  },
  profileName: {
    color: theme.palette.white,
    backgroundColor: theme.palette.white,
    padding: "5px 15px",
    borderRadius: 10,
    [theme.breakpoints.down("sm")]: {
      display: "none",
    },
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingRight: theme.spacing(1)
  },
  list: {
    width: '100%',
    minWidth: 220,
    maxWidth: 360
  },
  avatarWrap: {
    [theme.breakpoints.down('sm')]: {
      minWidth: 0,
    },
  },
  avatar: {
    border: '1px solid #FFF',
  }
}));

export default function Navbar() {
  const classesGlobal = useStylesGlobal()
  const classesPivate = useStylePivate()
  const router = useRouter();
  const [anchorEl, setAnchorEl] = React.useState(null);
  const [profile, setProfile] = React.useState([]);
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    getUser()
    const uid = localStorage.getItem("uid");
    const token = localStorage.getItem("token");
    (uid === null || token === null) && router.push("/signin")
  }, [])

  const getUser = () => {
    axios.post(process.env.API + "getUser", {
      uid: localStorage.getItem("uid")
    }, { headers: { "Authorization": `Bearer ${localStorage.getItem("token")}` } })
      .then(response => {
        setProfile(response.data.data)
      })
      .catch(error => {
        console.log(error)
        router.push("/signin")
      })
      .finally(function () {
        setLoading(false)
      })
  }

  const handleClick = event => {
    setAnchorEl(event.currentTarget);
  };

  const handleLogout = () => {
    localStorage.removeItem('uid')
    localStorage.removeItem('token')
    router.push("/signin", undefined, { shallow: true });
  };

  const handleDistance = () => {
    router.push("/distance", undefined, { shallow: true });
  };

  const handleUser = () => {
    router.push("/user", undefined, { shallow: true });
  };

  const handleClose = () => {
    setAnchorEl(null)
  };

  const handleProfile = () => {
    router.push("/profile")
  }

  const open = Boolean(anchorEl);
  const id = open ? 'simple-popover' : undefined;

  return (
    <Container disableGutters maxWidth="sm">
      <AppBar position="static" className={classesPivate.appBar}>
        <Toolbar className={classesPivate.toolbar}>
          <Link href="/">
            <Typography variant="h5" color="inherit" component="span" className={classesGlobal.cPointer}>
              Run ไม่เว้นวรรค&nbsp;&nbsp;
              <Typography variant="subtitle2" color="inherit" component="span" style={{ fontSize: 10 }}>(v 3.2.7)</Typography>
            </Typography>
          </Link>
          <div>
            <ListItem onClick={handleClick} className={classesGlobal.cPointer}>
              <ListItemAvatar className={classesPivate.avatarWrap}>
                <Avatar alt={profile.firstname} src={profile.avatar} className={classesPivate.avatar} />
              </ListItemAvatar>
              {/* <ListItemText className={classesPivate.profileName} primary={(profile.firstname || "") + ' ' + (profile.lastname || "")} secondary={profile.username} /> */}
            </ListItem>
            <Popover
              id={id}
              open={open}
              anchorEl={anchorEl}
              onClose={handleClose}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'center',
              }}
              transformOrigin={{
                vertical: 'top',
                horizontal: 'center',
              }}
            >
              <List component="nav" className={classesPivate.list}>
                <ListItem button onClick={handleProfile}>
                  <ListItemAvatar>
                    <Avatar alt={profile?.firstname} src={profile.avatar} />
                  </ListItemAvatar>
                  <ListItemText primary={(profile?.firstname || "") + ' ' + (profile?.lastname || "")} secondary={profile?.username || ""} />
                </ListItem>
                <Divider />
                <ListItem button onClick={() => router.push("/")}>
                  <ListItemIcon>
                    <HomeIcon />
                  </ListItemIcon>
                  <ListItemText primary="หน้าแรก" />
                </ListItem>
                <Divider />
                <ListItem button onClick={handleProfile}>
                  <ListItemIcon>
                    <AccountBoxIcon />
                  </ListItemIcon>
                  <ListItemText primary="ข้อมูลส่วนตัว" />
                </ListItem>
                {profile.role === "admin" &&
                  <>
                    <Divider />
                    <ListItem button onClick={handleDistance}>
                      <ListItemIcon>
                        <DirectionsRunIcon />
                      </ListItemIcon>
                      <ListItemText primary="ระบบจัดการ" />
                    </ListItem>
                    <Divider />
                    <ListItem button onClick={handleUser}>
                      <ListItemIcon>
                        <PeopleAltIcon />
                      </ListItemIcon>
                      <ListItemText primary="ผู้เข้าร่วมโครงการ" />
                    </ListItem>
                  </>
                }
                <Divider />
                <ListItem button onClick={handleLogout}>
                  <ListItemIcon>
                    <ExitToAppIcon />
                  </ListItemIcon>
                  <ListItemText primary="ออกจากระบบ" />
                </ListItem>
              </List>
            </Popover>
          </div>
        </Toolbar>
      </AppBar>
    </Container>
  )
}
