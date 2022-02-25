import Head from "next/head"
import {
  Container,
  Grid,
  Paper,
  Button,
  Typography,
  makeStyles,
} from "@material-ui/core";
import ErrorOutlineIcon from "@material-ui/icons/ErrorOutline";
import styles from "./../components/styles"
import Link from "next/link"
import classNames from "classnames"

const useStylesGlobal = makeStyles(styles);
const useStylePivate = makeStyles((theme) => ({
  icon: {
    fontSize: "5rem",
    width: "100%",
    marginBottom: theme.spacing(3)
  }
}));

export default function Custom404() {
  const classesGlobal = useStylesGlobal();
  const classesPivate = useStylePivate();

  return (
    <div>
      <Head>
        <title>iChord - 404</title>
      </Head>
      <Container disableGutters maxWidth="sm">
        <Grid container alignItems="center" justify="center" style={{ height: "100vh" }}>
          <Paper square elevation={0} className={classNames(classesGlobal.card, classesGlobal.mb0)}>
            <Grid container>
              <Grid item xs={12}>
                <ErrorOutlineIcon color="error" className={classesPivate.icon} />
              </Grid>
              <Grid item xs={12}>
                <Typography variant="h4" align="center" className={classesGlobal.mb3}>
                  404 - Page Not Found
                </Typography>
              </Grid>
              <Grid item xs={12}>
                <Link href="/signin">
                  <Button
                    type="submit"
                    size="large"
                    fullWidth
                    color="primary"
                    variant="contained"
                    className={classesGlobal.btn}>
                    กลับสู่หน้าหลัก
                  </Button>
                </Link>
              </Grid>
            </Grid>
          </Paper>
        </Grid>
      </Container>
    </div>
  );
}
