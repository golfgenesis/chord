import { useState } from "react"
import Head from "next/head"
import { makeStyles } from "@material-ui/core/styles"
import {
  Container,
  Typography,
  Button,
  Paper,
  Grid,
  Backdrop,
  CircularProgress
} from "@material-ui/core"
import { ValidatorForm, TextValidator } from "react-material-ui-form-validator"
import axios from "axios"
import Link from "next/link"
import classNames from "classnames"
import { useRouter } from "next/router"
import styles from "./../components/styles"
import Modal from "../components/modal"

const useStylesGlobal = makeStyles(styles)
const useStylePivate = makeStyles((theme) => ({
  title: {
    paddingBottom: theme.spacing(3)
  }
}))

export default function Signin() {
  const classesGlobal = useStylesGlobal()
  const classesPivate = useStylePivate()
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [values, setValues] = useState({
    username: "",
    password: "",
  })
  const [alert, setAlert] = useState()

  const handleChange = (event) => {
    if (event.target.name === "username") {
      setValues({
        ...values,
        [event.target.name]: event.target.value.toLowerCase(),
      })
    } else {
      setValues({
        ...values,
        [event.target.name]: event.target.value,
      })
    }
  }

  const handleSubmit = () => {
    setLoading(true)
    axios
      .post(process.env.API + "signin", values)
      .then(res => {
        localStorage.setItem("uid", res.data.uid)
        localStorage.setItem("token", res.data.token)
        router.push("/")
      })
      .catch(err => {
        setValues({ ...values, password: "" })
        setAlert({
          content: err.response.data?.message,
          type: "error"
        })
      })
      .finally(function () {
        setLoading(false)
      })
  }

  return (
    <div>
      <Head>
        <title>Run ไม่เว้นวรรค - เข้าสู่ระบบ</title>
        <link rel="icon" href="/favicon.png" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no" />
        <meta name="title" content="Run ไม่เว้นวรรค - เข้าสู่ระบบ" />
        <meta name="description" content="ระบบที่ช่วยจดจำการวิ่งของคุณในแต่ละวัน อีกทั้งยังสามารถคำนวนแคลอรี่ของคุณที่เผาพลาญไปได้ คุณสามารถส่งผลการวิ่งของคุณในแต่ละวันได้แล้วที่นี่" />
        <meta name="keywords" content="runforround,run" />
        <meta name="author" content="Chairat Akkaramethachote" />
        <meta name="twitter:title" content="Run ไม่เว้นวรรค - เข้าสู่ระบบ" />
        <meta name="twitter:description" content="ระบบที่ช่วยจดจำการวิ่งของคุณในแต่ละวัน อีกทั้งยังสามารถคำนวนแคลอรี่ของคุณที่เผาพลาญไปได้ คุณสามารถส่งผลการวิ่งของคุณในแต่ละวันได้แล้วที่นี่" />
        <meta name="twitter:image" content="https://runforround.web.app/images/meta.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta property="og:url" content="https://runforround.web.app/" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Run ไม่เว้นวรรค - เข้าสู่ระบบ" />
        <meta property="og:description" content="ระบบที่ช่วยจดจำการวิ่งของคุณในแต่ละวัน อีกทั้งยังสามารถคำนวนแคลอรี่ของคุณที่เผาพลาญไปได้ คุณสามารถส่งผลการวิ่งของคุณในแต่ละวันได้แล้วที่นี่" />
        <meta property="og:image" content="https://runforround.web.app/images/meta.png" />
      </Head>
      <Backdrop open={loading} className={classesGlobal.backdrop}>
        <CircularProgress color="inherit" />
      </Backdrop>
      <Container disableGutters maxWidth="sm">
        <Grid container alignItems="center" justify="center" className={classesGlobal.h100vh}>
          <Paper square elevation={0} className={classNames(classesGlobal.card, classesGlobal.mb0)}>
            <Typography variant="h2" align="center" className={classesPivate.title}>
              Sign in
            </Typography>
            <Typography variant="h6" align="center" className={classesPivate.title}>
              Sign in to continue
            </Typography>
            <ValidatorForm
              onSubmit={handleSubmit}
              onError={err => console.log(err)}>
              <Grid container spacing={2}>
                <Grid item xs={12}>
                  <TextValidator
                    fullWidth
                    label="อีเมล"
                    type="email"
                    name="username"
                    onChange={handleChange}
                    value={values.username}
                    validators={["required", "isEmail"]}
                    errorMessages={["กรุณากรอกข้อมูล", "อีเมลไม่ถูกต้อง"]} />
                </Grid>
                <Grid item xs={12}>
                  <TextValidator
                    fullWidth
                    label="รหัสผ่าน"
                    name="password"
                    type="password"
                    onChange={handleChange}
                    value={values.password}
                    validators={["required"]}
                    errorMessages={["กรุณากรอกข้อมูล"]} />
                </Grid>
                <Grid item xs={12} className={classesGlobal.forgotLink}>
                  <Typography>
                    <Link href="/resetpassword">
                      <a className={classesGlobal.linkColor}>
                        ลืมรหัสผ่าน ?
                      </a>
                    </Link>
                  </Typography>
                </Grid>
                <Grid item xs={12} className={classesGlobal.btnLayout}>
                  <Button
                    type="submit"
                    size="large"
                    fullWidth
                    color="primary"
                    variant="contained"
                    className={classesGlobal.btn}>
                    ลงชื่อเข้าใช้งาน
                  </Button>
                </Grid>
                <Grid item xs={12} align="center">
                  <Typography variant="caption" component="span">ไม่มีบัญชีใช่หรือไม่&nbsp;</Typography>
                  <Typography component="span">
                    <Link href="/signup">
                      <a
                        className={classNames(
                          classesGlobal.signupLink,
                          classesGlobal.linkColor,
                        )}
                      >
                        <u>สร้างบัญชีของคุณ</u>
                      </a>
                    </Link>
                  </Typography>
                </Grid>
              </Grid>
            </ValidatorForm>
          </Paper>
        </Grid>
      </Container>
      <Modal
        action={() => setAlert({ ...alert, content: null })}
        {...alert} />
    </div>
  )
}
