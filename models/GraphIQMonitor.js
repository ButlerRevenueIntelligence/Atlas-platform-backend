import mongoose from 'mongoose';
const search = new mongoose.Schema({
  kind: {
    type: String,
    enum: ['news', 'companies'],
    required: true
  },
  query: {
    type: String,
    required: true,
    maxlength: 500
  },
  sourcePage: {
    type: String,
    enum: ['market-signals', 'account-intelligence'],
    required: true
  }
}, {
  _id: false
});
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  intervalMinutes: {
    type: Number,
    enum: [60, 360, 1440],
    default: 360
  },
  searches: {
    type: [search],
    default: [],
    validate: v => v.length <= 5
  },
  revision: {
    type: Number,
    default: 0
  },
  nextRunAt: {
    type: Date,
    default: Date.now
  },
  leaseUntil: {
    type: Date,
    default: () => new Date(0)
  },
  claim: {
    type: String,
    default: null,
    select: false
  },
  failureCount: {
    type: Number,
    default: 0
  },
  lastRunAt: Date,
  lastCompletedAt: Date,
  lastState: {
    type: String,
    default: 'never'
  },
  lastReason: String,
  lastResults: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  }
}, {
  timestamps: true,
  collection: 'graphiq_monitors'
});
schema.index({
  enabled: 1,
  nextRunAt: 1,
  leaseUntil: 1
});
export default mongoose.models.GraphIQMonitor || mongoose.model('GraphIQMonitor', schema);
