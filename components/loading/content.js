import React from 'react'
import Skeleton from '@material-ui/lab/Skeleton';
import {
	Grid,
	makeStyles
} from "@material-ui/core"
import styles from "./../styles"

const useStyles = makeStyles((theme) => ({
	search: {
		backgroundColor: "#242526",
		padding: theme.spacing(5, 0)
	},
	content: {
		backgroundColor: "#18191A",
		marginTop: 10
	},
}));

const LoadingContentChord = props => {
	const classes = useStyles()
	const classesGlobal = styles()
	return (
		<React.Fragment>
			<Grid container justify="center" alignItems="center">
				<Grid item xs={12}>
					<Grid container className={classes.search}>
						<Grid item xs={12} align="center" >
							<Skeleton animation="wave" variant="rect" width="50%" height={50} className={classesGlobal.my5} />
						</Grid>
						<Grid item xs={12} align="center">
							<Skeleton animation="wave" variant="rect" width="80%" height={40} className={classesGlobal.my5} />
						</Grid>
					</Grid>
				</Grid>
				<Grid item xs={12} className={classes.content}>
					{[...Array(10)].map((items, index) => {
						return (
							<Grid key={index} container justify="space-between">
								<Grid item xs={12}>
									<Skeleton animation="wave" variant="rect" width="100%" height={60} className={classesGlobal.mb1} />
								</Grid>
							</Grid>
						)
					})}
				</Grid>
			</Grid>
		</React.Fragment>
	)
}

export { LoadingContentChord }