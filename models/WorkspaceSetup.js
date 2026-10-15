import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true
  },
  priorities: [{
    type: String,
    enum: ['pipeline', 'forecast', 'accounts', 'cash']
  }],
  expectedSystems: [{
    type: String
  }],
  status: {
    type: String,
    enum: ['in_progress', 'deferred', 'completed'],
    default: 'in_progress'
  },
  coverageReviewedAt: {
    type: Date,
    default: null
  },
  coverageReview: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  briefing: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  firstBriefingAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  completionReview: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  }
}, {
  timestamps: true,
  collection: 'workspace_setups'
});
export default mongoose.models.WorkspaceSetup || mongoose.model('WorkspaceSetup', schema);
