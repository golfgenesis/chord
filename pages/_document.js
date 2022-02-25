import React from "react";
import Document, { Html, Head, Main, NextScript } from "next/document";
import { ServerStyleSheets } from "@material-ui/core/styles";
import theme from "../theme";

export default class MyDocument extends Document {
  render() {
    return (
      <Html lang="en">
        <Head>
          <meta name="theme-color" content={theme.palette.primary.main} />
          <meta name="description" content="แอพพลิเคชั่นที่ช่วยให้คุณสามารถดูคอร์ดกีต้าร์และเชื่อมต่อกันในวงได้อย่างรวดเร็ว" />
          <meta name="keywords" content="ichord,chordtabs,chord,chordtab" />
          <meta name="author" content="Chairat Akkaramethachote" />
          <meta name="title" content="iChord" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />

          <meta name='application-name' content='iChord' />
          <meta name='apple-mobile-web-app-capable' content='yes' />
          <meta name='apple-mobile-web-app-status-bar-style' content='default' />
          <meta name='apple-mobile-web-app-title' content='iChord' />
          <meta name='description' content='แอพพลิเคชั่นที่ช่วยให้คุณสามารถดูคอร์ดกีต้าร์และเชื่อมต่อกันในวงได้อย่างรวดเร็ว' />
          <meta name='format-detection' content='telephone=no' />
          <meta name='mobile-web-app-capable' content='yes' />
          <meta name='msapplication-config' content='/icons/browserconfig.xml' />
          <meta name='msapplication-TileColor' content='#18191A' />
          <meta name='msapplication-tap-highlight' content='no' />
          <meta name='theme-color' content='#18191A' />

          <link rel='apple-touch-icon' sizes='180x180' href='/images/meta.png' />
          <link rel='icon' type='image/png' sizes='32x32' href='/images/meta.png' />
          <link rel='icon' type='image/png' sizes='16x16' href='/images/meta.png' />
          <link rel='manifest' href='/manifest.json' />
          <link rel='mask-icon' href='/icons/safari-pinned-tab.svg' color='#18191A' />
          <link rel="icon" href="/favicon.png" />
          <link href="https://fonts.googleapis.com/css2?family=Kanit:wght@100;200;300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
          <link href="https://fonts.googleapis.com/css2?family=Raleway:wght@100;200;300;400;500;600;700;800;900&display=swap" rel="stylesheet" />

          <meta name='twitter:card' content='summary_large_image' />
          <meta name='twitter:url' content='https://ichordapp.web.app/' />
          <meta name='twitter:title' content='iChord' />
          <meta name='twitter:description' content='แอพพลิเคชั่นที่ช่วยให้คุณสามารถดูคอร์ดกีต้าร์และเชื่อมต่อกันในวงได้อย่างรวดเร็ว' />
          <meta name='twitter:image' content='https://ichordapp.web.app/images/meta.png' />
          <meta name='twitter:creator' content='@DavidWShadow' />
          <meta property='og:type' content='website' />
          <meta property='og:title' content='iChord' />
          <meta property='og:description' content='แอพพลิเคชั่นที่ช่วยให้คุณสามารถดูคอร์ดกีต้าร์และเชื่อมต่อกันในวงได้อย่างรวดเร็ว' />
          <meta property='og:site_name' content='iChord' />
          <meta property='og:url' content='https://ichordapp.web.app/' />
          <meta property='og:image' content='https://ichordapp.web.app/images/meta.png' />

        </Head>
        <body style={{ backgroundColor: "#18191A" }}>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

// `getInitialProps` belongs to `_document` (instead of `_app`),
// it's compatible with server-side generation (SSG).
MyDocument.getInitialProps = async (ctx) => {
  // Resolution order
  //
  // On the server:
  // 1. app.getInitialProps
  // 2. page.getInitialProps
  // 3. document.getInitialProps
  // 4. app.render
  // 5. page.render
  // 6. document.render
  //
  // On the server with error:
  // 1. document.getInitialProps
  // 2. app.render
  // 3. page.render
  // 4. document.render
  //
  // On the client
  // 1. app.getInitialProps
  // 2. page.getInitialProps
  // 3. app.render
  // 4. page.render

  // Render app and page and get the context of the page with collected side effects.
  const sheets = new ServerStyleSheets();
  const originalRenderPage = ctx.renderPage;

  ctx.renderPage = () =>
    originalRenderPage({
      enhanceApp: (App) => (props) => sheets.collect(<App {...props} />),
    });

  const initialProps = await Document.getInitialProps(ctx);

  return {
    ...initialProps,
    // Styles fragment is rendered after the app and page rendering finish.
    styles: [
      ...React.Children.toArray(initialProps.styles),
      sheets.getStyleElement(),
    ],
  };
};
