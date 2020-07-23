import { createSelector } from 'reselect';
import * as topojson from 'topojson-client';
import bbox from '@turf/bbox';
import {
  rollup,
  extent,
  quantile,
  max,
  min,
  mean,
} from 'd3-array';
import { scaleSequential, geoContains } from 'd3';
import { State } from '../../utils/types';
import * as Helpers from '../../utils/helpers';
import { processStations } from '../../utils/dataProcessing';
import {
  KEYS as K, appConfig, colorInterpolator,
  VIEWS as V,
} from '../../utils/constants';

/** Basic Selectors */
// TODO: refactor base selectors to take state instead of store
export const getSectionData = (state: State) => state.sectionData;
export const getSwipeData = (state: State) => state.swipeData;
export const getStationData = (state: State) => state.stationData;
export const getMapData = (state: State) => state.mapData;
export const getView = (state: State) => state.view;
export const getSelectedWeek = (state: State) => state.selectedWeek;

/** Turnstile Manipulations */
export const getFilteredSwipeData = createSelector([
  getSwipeData,
], (data) => data.filter(({ WEEK }) => WEEK >= appConfig.startDate));

export const getOverallTimeline = createSelector([
  getFilteredSwipeData,
], (data) => data && processStations(data, true));

export const getStationRollup = createSelector([
  getFilteredSwipeData,
], (data) => data
  && rollup(data, processStations,
    ({ REMOTE }) => REMOTE));

/** GEOGRAPHIC TRANSFORMATIONS */
export const getMapOutline = createSelector([getMapData],
  (data) => topojson.feature(data, data.objects.mapOutline));

export const getLinesData = createSelector([getMapData],
  (data) => topojson.feature(data, data.objects['subway-lines']));

// filter out Staten Island
const getFilteredACSData = createSelector([
  getMapData,
], (data) => ({
  ...data,
  objects: {
    acs_nta: {
      ...data.objects.acs_nta,
      geometries: data.objects.acs_nta.geometries
        .filter(({ properties }) => properties.BoroCode !== 5), // FIXME: want to keep in nta but still size view to central stations
    },
  },
}));

const getACSGeometries = createSelector([
  getFilteredACSData,
], (data) => data.objects.acs_nta.geometries);

export const getNTAFeatures = createSelector([
  getFilteredACSData,
], (data) => topojson.feature(data, data.objects.acs_nta));

export const getGeoMeshInterior = createSelector([
  getFilteredACSData,
], (data) => topojson.mesh(data, data.objects.acs_nta,
  (a, b) => a !== b));

export const getGeoMeshExterior = createSelector([
  getFilteredACSData,
], (data) => topojson.mesh(data, data.objects.acs_nta,
  (a, b) => a === b));


/** EXTENTS */
export const getDemoDataExtents = createSelector([
  getStationData,
  getACSGeometries,
], (stations, acs): { [key: string]: (number | Date | string)[] } => ({
  [K.BOROUGH]: Helpers.getUnique(stations, (d) => d[K.BOROUGH]),
  [K.ED_HEALTH_PCT]: extent(acs, ({ properties }) => +properties[K.ED_HEALTH_PCT]),
  [K.INCOME_PC]: [0, max(acs, ({ properties }) => +properties[K.INCOME_PC])],
  [K.UNINSURED]: [0, quantile(acs.map(({ properties }) => +properties[K.UNINSURED]), 0.99)],
  [K.SNAP_PCT]: [0, quantile(acs.map(({ properties }) => +properties[K.SNAP_PCT]), 0.99)],
  [K.WHITE]: [0, quantile(acs.map(({ properties }) => +properties[K.WHITE]), 0.99)],
}));

export const getWeeklyDataExtent = createSelector([
  getSelectedWeek,
  getStationRollup,
], (week, stationStats): number[] => {
  const currentWeekStationStats = [...stationStats].map(([, { timeline }]) => timeline.get(week));
  return extent(currentWeekStationStats.map((d) => d && d.swipes_pct_chg));
});

const getSummarySwipeExtent = createSelector([
  getStationRollup,
], (stationStats) => ([
  min([...stationStats]
    .map(([, val]) => val)
    .map(({ summary }) => summary.swipes_pct_chg)),
  quantile(
    [...stationStats]
      .map(([, val]) => val)
      .map(({ summary }) => summary.swipes_pct_chg), 0.99,
  )]));

/** color should be stable throughout the app  */
export const getColorScheme = createSelector([
  getSummarySwipeExtent,
], (e) => scaleSequential(colorInterpolator)
  .domain(e as [number, number]));

/** creates a map from NTACode => ACS summary data */
export const getStationToACSMap = createSelector([
  getACSGeometries,
], (data) => data
  && new Map(data.map(({ properties }) => ([properties.NTACode, properties]))));


// get bounding boxes surounding each focus neighborhood
export const getSelectedNTAS = createSelector([
  getStationData,
  getStationRollup,
  getNTAFeatures,
], (stations, swipes, ntas) => {
  // helper function to grab relevant stations and return their average percent change
  const getAvgPctChg = (nta) => {
    const relevantStations = stations.filter((d) => geoContains(nta, [d.long, d.lat]));
    return mean(relevantStations
      .map((d) => swipes.get(d.unit)
      && swipes.get(d.unit).summary.swipes_pct_chg));
  };

  return ntas && [
    'MN24', // SOHO
    'BK81', // Brownsville
  ].map((code) => {
    const nta = ntas.features.find((d) => d.properties.NTACode === code);
    return {
      ...nta,
      properties: { ...nta.properties, [K.SWIPES_PCT_CHG]: getAvgPctChg(nta) },
    };
  });
});

export const getNTAbboxes = createSelector([
  getSelectedNTAS,
], ([soho, brownsville]) => (soho && brownsville && {
  [V.ZOOM_SOHO]: bbox(soho),
  [V.ZOOM_BROWNSVILLE]: bbox(brownsville),
}));
