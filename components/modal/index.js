import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  DialogTitle,
  Typography,
  makeStyles
} from "@material-ui/core";
import CheckCircleOutlineOutlinedIcon from '@material-ui/icons/CheckCircleOutlineOutlined'
import ErrorOutlineIcon from "@material-ui/icons/ErrorOutline";
import CancelOutlinedIcon from '@material-ui/icons/CancelOutlined';

const useStylePivate = makeStyles((theme) => ({
  root: {
    textAlign: "center",
    justifyContent: "center"
  },
  icon: {
    fontSize: "5rem",
    width: "100%",
    margin: theme.spacing(3, 0),
  }
}));

export default function Modal({ action, cancel, ...rest }) {
  const classesPivate = useStylePivate();

  return (
    <Dialog open={rest?.content ? true : false} maxWidth="sm" className={classesPivate.root}>
      {rest?.type === "error"
        ? <CancelOutlinedIcon color="error" className={classesPivate.icon} />
        : rest?.type === "warning"
          ? <ErrorOutlineIcon color="disabled" className={classesPivate.icon} />
          : <CheckCircleOutlineOutlinedIcon color="primary" className={classesPivate.icon} />
      }
      <DialogTitle>
        <Typography variant="h3" component="p">
          {rest?.type === "error"
            ? "เกิดข้อผิดพลาด"
            : rest?.type === "warning"
              ? "คุณแน่ใจใช่หรือไม่"
              : "สำเร็จ"
          }
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography component="div">
          {rest?.content}
        </Typography>
      </DialogContent>
      <DialogActions>
        {rest?.type === "warning"
          ? <>
            <Button onClick={cancel} color="primary">ยกเลิก</Button>
            <Button onClick={action} color="primary" autoFocus>ตกลง</Button>
          </>
          : <Button onClick={action} color="primary" autoFocus>ตกลง</Button>
        }
      </DialogActions>
    </Dialog>
  )
}
