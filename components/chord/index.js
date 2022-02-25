import React, { useState, useEffect } from "react";
import tableIcons from "./styles/tableIcons";
import MaterialTable, { MTableToolbar } from "material-table";
import { Avatar, Grid, Typography } from "@material-ui/core";
import _ from "lodash";
import { db, storage } from "./../firebase";
import useStyles from "./styles";
import moment from "moment";
import Preview from "./preview";
import localforage from "localforage";

export default function ChordLists(props) {
  const classes = useStyles();
  const { song } = props;
  const [columns] = useState([
    {
      title: "ชื่อเพลง",
      field: "name",
      cellStyle: { backgroundColor: "center" },
    },
    { title: "ศิลปิน", field: "artist" },
    { title: "เมโทนอม", field: "tempo" },
  ]);
  const [isOpen, setIsOpen] = useState(false);
  const [rowData, setRowData] = useState("");
  const [songGlobal, setSongGlobal] = useState("");

  useEffect(() => {
    getSearch();
    handleSubmit("เลือกเพลง...", "gtr");
    return () => {
      getSearch();
    };
  }, []);

  const handleClick = (rowData) => {
    setRowData(rowData);
    let showSong = rowData.tempo
      ? rowData.name +
        (rowData.artist && ` - ${rowData.artist}`) +
        ` (${rowData.tempo})`
      : rowData.name + (rowData.artist && ` - ${rowData.artist}`);
    handleSubmit(showSong, "gtr");
    setIsOpen(true);
  };

  const handleEdit = (rowData) => {
    // db.collection("song").doc(rowData.chord_id).delete()
    //   .then(function () {
    //     removeImage(rowData)
    //   })
    //   .catch(err => {
    //     console.error("Error removing document: ", err);
    //   })
  };

  const handleRemove = (rowData) => {
    db.collection("song")
      .doc(rowData.chord_id)
      .delete()
      .then(function () {
        removeImage(rowData);
      })
      .catch((err) => {
        console.error("Error removing document: ", err);
      });
  };

  const removeImage = (rowData) => {
    const desertRef = storage.ref(`song/${rowData.chord_id}`);
    desertRef
      .delete()
      .then(function () {
        let newArray = song;
        newArray = song.filter((item) => item.chord_id !== rowData.chord_id);
        localforage
          .setItem("song", newArray)
          .then(function () {
            return localforage.getItem("song");
          })
          .then((value) => {
            window.location.reload();
          })
          .catch((err) => {
            console.log(err);
          });
      })
      .catch((err) => {
        console.error(err);
        localforage.removeItem("song");
        window.location.reload();
      });
  };

  const handleSubmit = (value, roomName) => {
    db.collection("room")
      .doc(roomName)
      .set({
        room_id: moment().unix(),
        name: roomName,
        search: value,
        dateCreate: moment().format(),
      })
      .then(function () {
        console.log("Document successfully written!");
      })
      .catch(function (error) {
        console.error("Error writing document: ", error);
      });
  };

  const getSearch = () => {
    db.collection("room")
      .where("name", "==", "gtr")
      .onSnapshot((querySnapshot) => {
        const data = [];
        querySnapshot.forEach((document) => {
          data.push(document.data());
        });
        setSongGlobal(data[0].search);
      });
  };

  return (
    <React.Fragment>
      <Preview data={rowData} open={isOpen} setIsOpen={setIsOpen} />
      <MaterialTable
        icons={tableIcons}
        columns={columns}
        options={{
          pageSize: 15,
          pageSizeOptions: [15, 30, 50],
          searchFieldAlignment: "left",
          searchFieldStyle: {
            width: "70vw",
            color: "white",
            fontSize: "max(2.5vw, 16px)",
          },
          showTitle: false,
          headerStyle: {
            backgroundColor: "#242526",
            color: "white",
            fontSize: "max(2vw, 14px)",
          },
          rowStyle: {
            backgroundColor: "#242526",
            color: "white",
          },
          actionsColumnIndex: -1,
        }}
        style={{
          borderRadius: 0,
          fontSize: "max(2vw, 14px)",
          boxShadow: "none",
          backgroundColor: "#18191A",
        }}
        localization={{
          toolbar: {
            searchPlaceholder: "ค้นหาเพลง",
          },
          pagination: {
            labelRowsSelect: "เพลง",
          },
          header: {
            actions: "แก้ไข/ลบ",
          },
        }}
        components={{
          Toolbar: (props) => (
            <div>
              <Grid
                container
                justify="center"
                alignItems="center"
                className={classes.search}
              >
                <Grid item xs={12} align="center">
                  <Typography variant="h1" className={classes.titleSong}>
                    {songGlobal}
                  </Typography>
                </Grid>
                <Grid item>
                  <MTableToolbar {...props} />
                </Grid>
              </Grid>
            </div>
          ),
        }}
        onRowClick={(event, rowData) => handleClick(rowData)}
        data={song}
        actions={[
          {
            icon: tableIcons.Edit,
            tooltip: "แก้ไขข้อมูล",
            onClick: (event, rowData) => handleEdit(rowData),
          },
          {
            icon: tableIcons.Delete,
            tooltip: "ลบเพลงนี้",
            onClick: (event, rowData) => handleRemove(rowData),
          },
        ]}
      />
    </React.Fragment>
  );
}
