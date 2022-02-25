import React from "react";
import PropTypes from "prop-types";
import { ThemeProvider } from "@material-ui/core/styles";
import CssBaseline from "@material-ui/core/CssBaseline";
import theme from "../theme";
import Fade from '@material-ui/core/Fade';
import Snackbar from '@material-ui/core/Snackbar';
import Button from '@material-ui/core/Button';
export default function MyApp(props) {
  const { Component, pageProps } = props;

  React.useEffect(() => {
    const jssStyles = document.querySelector("#jss-server-side");
    if (jssStyles) {
      jssStyles.parentElement.removeChild(jssStyles);
    }

    // Install Bar
    let deferredPrompt;
    const addBtn = document.querySelector('.add-button');
    const snackbar = document.querySelector('.snackbar');
    addBtn.style.display = 'none';
    snackbar.style.display = 'none';

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      addBtn.style.display = 'block';
      snackbar.style.display = 'block';

      addBtn.addEventListener('click', (e) => {
        addBtn.style.display = 'none';
        snackbar.style.display = 'none';
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the A2HS prompt');
          } else {
            console.log('User dismissed the A2HS prompt');
          }
          deferredPrompt = null;
        });
      });
    });
  }, []);

  return (
    <React.Fragment>
      <ThemeProvider theme={theme}>
        <Snackbar
          open
          TransitionComponent={Fade}
          style={{ top: 30 }}
          className="snackbar"
          message="ติดตั้งแอพนี้ ลงบนอุปกรณ์ของคุณ"
          action={
            <div style={{ marginTop: 5, marginBottom: 5 }}>
              <Button color="primary" size="large" variant="contained" className="add-button">
                ติดตั้ง
            </Button>
            </div>
          }
        />
        <CssBaseline />
        <Component {...pageProps} />
      </ThemeProvider>
    </React.Fragment>
  );
}

MyApp.propTypes = {
  Component: PropTypes.elementType.isRequired,
  pageProps: PropTypes.object.isRequired,
};
