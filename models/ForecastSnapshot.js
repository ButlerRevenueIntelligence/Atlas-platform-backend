import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  period: {
    type: String,
    required: true
  },
  metric: {
    type: String,
    required: true
  },
  currency: {
    type: String,
    enum: ['USD'],
    default: 'USD'
  },
  label: {
    type: String,
    required: true,
    maxlength: 120
  },
  asOf: {
    type: Date,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  workspaceMode: {
    type: String,
    enum: ['demo', 'live'],
    required: true
  },
  forecast: {
    type: Number,
    required: true
  },
  modelForecast: {
    type: Number,
    default: null
  },
  method: {
    type: String,
    enum: ['weighted_pipeline', 'trailing_30_days', 'leadership_estimate'],
    required: true
  },
  rationale: {
    type: String,
    maxlength: 2000,
    default: ''
  },
  actualAtSave: {
    type: Number,
    default: null
  },
  targetAtSave: {
    type: Number,
    default: null
  },
  evidence: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  }
}, {
  timestamps: true,
  collection: 'forecast_snapshots'
});
schema.index({
  orgId: 1,
  metric: 1,
  asOf: -1
});
export default mongoose.models.ForecastSnapshot || mongoose.model('ForecastSnapshot', schema);
