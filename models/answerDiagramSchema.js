import mongoose from 'mongoose';

// Shared "one small diagram" sub-schema. `kind` picks the form; only that kind's
// fields are filled. Rendered by finaldh-frontend/src/components/AnswerDiagram.jsx
// and coerced server-side by utils/toppersAnalysis.js `shapeDiagram()`.
// Used by both ToppersCopy (per-question AI analysis) and ToppersPyq (per-PYQ
// model answer).

const diagramNodeSchema = new mongoose.Schema({
  id: { type: String, default: '' },
  label: { type: String, default: '' },              // a theme keyword — this is what gets drawn
  shape: { type: String, default: 'box' },           // box | circle | pill | diamond
}, { _id: false });

const diagramEdgeSchema = new mongoose.Schema({
  from: { type: String, default: '' },
  to: { type: String, default: '' },
  label: { type: String, default: '' },              // optional 1-2 word link
}, { _id: false });

const diagramTableRowSchema = new mongoose.Schema({
  cells: { type: [String], default: [] },
}, { _id: false });

const diagramPointSchema = new mongoose.Schema({
  label: { type: String, default: '' },              // category name / year
  value: { type: Number, default: 0 },
}, { _id: false });

const diagramSeriesSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  points: { type: [diagramPointSchema], default: [] },
}, { _id: false });

const diagramQuadrantItemSchema = new mongoose.Schema({
  label: { type: String, default: '' },
  x: { type: Number, default: 0 },                   // -1..1
  y: { type: Number, default: 0 },                   // -1..1
}, { _id: false });

const diagramEventSchema = new mongoose.Schema({
  when: { type: String, default: '' },               // year / phase
  label: { type: String, default: '' },
}, { _id: false });

const answerDiagramSchema = new mongoose.Schema({
  kind: { type: String, default: 'flow' },           // flow | table | chart | quadrant | pyramid | timeline
  title: { type: String, default: '' },
  howToDraw: { type: String, default: '' },          // reproducible in ~20s under exam pressure
  keywords: { type: [String], default: [] },         // labels that must appear on the diagram

  // kind: flow
  layout: { type: String, default: 'flow-vertical' }, // flow-vertical | flow-horizontal | cycle | hub-spoke
  nodes: { type: [diagramNodeSchema], default: [] },
  edges: { type: [diagramEdgeSchema], default: [] },
  mermaid: { type: String, default: '' },            // same graph as Mermaid, back-compat / fallback

  // kind: table
  columns: { type: [String], default: [] },          // first column is the row label
  rows: { type: [diagramTableRowSchema], default: [] },

  // kind: chart
  chartType: { type: String, default: 'bar' },       // bar | pie | line
  unit: { type: String, default: '' },
  source: { type: String, default: '' },             // where the numbers come from — required for a chart
  series: { type: [diagramSeriesSchema], default: [] },

  // kind: quadrant
  xAxis: {
    low: { type: String, default: '' },
    high: { type: String, default: '' },
  },
  yAxis: {
    low: { type: String, default: '' },
    high: { type: String, default: '' },
  },
  quadrantItems: { type: [diagramQuadrantItemSchema], default: [] },

  // kind: pyramid
  levels: { type: [String], default: [] },           // top level first, then downward

  // kind: timeline
  events: { type: [diagramEventSchema], default: [] },
}, { _id: false });

export default answerDiagramSchema;
