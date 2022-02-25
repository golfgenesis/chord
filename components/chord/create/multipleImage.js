import React, { useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Typography } from '@material-ui/core';
import useStyles from '../styles';
import PhotoCameraOutlinedIcon from '@material-ui/icons/PhotoCameraOutlined';

export default function MultipleImage(props) {
  const { files, setFiles, setAlert } = props
  const classes = useStyles();
  const { getRootProps, getInputProps } = useDropzone({
    accept: 'image/*',
    onDrop: acceptedFiles => {
      setFiles(acceptedFiles.map(file => Object.assign(file, {
        preview: URL.createObjectURL(file)
      })));
    },
    maxSize: 2097152,
    onDropRejected: errors => {
      errors.map(err =>
        err.errors.forEach(element => {
          setAlert(element.message)
        })
      )
    }
  });

  const thumbs = files.map(file => (
    <div className={classes.thumb} key={file.name}>
      <div className={classes.thumbInner}>
        <img src={file.preview} className={classes.img} />
      </div>
    </div>
  ));

  useEffect(() => () => {
    files.forEach(file => URL.revokeObjectURL(file.preview));
  }, [files]);

  return (
    <>
      <div {...getRootProps({ className: classes.dropbox })}>
        <input {...getInputProps()} />
        <Typography align="center" component="div">
          <PhotoCameraOutlinedIcon color="primary" style={{ fontSize: 40 }} />
          <p>วางรูปภาพของคุณที่นี่</p>
        </Typography>
      </div>
      <aside className={classes.thumbsContainer}>
        {thumbs}
      </aside>
    </>
  );
}