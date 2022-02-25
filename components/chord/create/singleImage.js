import React, { useState } from 'react';
import { Typography, Grid } from '@material-ui/core';
import PhotoCameraOutlinedIcon from '@material-ui/icons/PhotoCameraOutlined';
import DeleteIcon from '@material-ui/icons/Delete';
import _ from 'lodash';
import { useDropzone } from 'react-dropzone'
import useStyles from '../styles';

export default function SigleImage(props) {
  const { files, setFiles, setAlert } = props
  const classes = useStyles();
  const { getRootProps, getInputProps } = useDropzone({
    accept: 'image/*',
    multiple: false,
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
    <Grid container className={classes.uploadBox} key={file.name}>
      <Grid item xs={12}>
        <img className={classes.imageUpload} src={file.preview} alt="chord" />
      </Grid>
    </Grid>
  ));

  return (
    <>
      {!_.isEmpty(files)
        ? thumbs
        : <div {...getRootProps({ className: classes.dropbox })}>
          <input {...getInputProps()} />
          <Typography align="center" component="div">
            <PhotoCameraOutlinedIcon color="primary" style={{ fontSize: 40 }} />
            <p>วางรูปภาพของคุณที่นี่</p>
          </Typography>
        </div>
      }
      {!_.isEmpty(files) &&
        <Grid container justify="center" alignItems="center" item xs={12} onClick={() => setFiles([])}>
          <DeleteIcon color="error" />
          <span>Delete</span>
        </Grid>
      }
    </>
  );
}