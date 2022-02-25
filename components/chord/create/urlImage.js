import React, { useEffect } from 'react';
import { InputAdornment } from '@material-ui/core';
import LinkIcon from '@material-ui/icons/Link';
import _ from 'lodash';
import { ValidatorForm, TextValidator } from "react-material-ui-form-validator"

export default function URLImage(props) {
  const { urlImage, setUrlImage } = props

  useEffect(() => {
    ValidatorForm.addValidationRule('isHttps', (value) => {
      var isHttps = value.search("https");
      if (isHttps === 0) {
        return true;
      }
      return false;
    });
  }, [])

  return (
    <TextValidator
      fullWidth
      label="URL Image"
      name="urlImage"
      autoComplete="off"
      onChange={e => setUrlImage(e.target.value)}
      placeholder="กรุณาใส่ URL Image"
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <LinkIcon color="primary" />
          </InputAdornment>
        ),
      }}
      value={urlImage}
      validators={["required", "isHttps"]}
      errorMessages={["กรุณากรอกข้อมูล", "Link ควรมีความปลอดภัยและเป็น HTTPS"]} />
  );
}