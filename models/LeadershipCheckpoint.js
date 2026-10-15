import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  label: {
    type: String,
    required: true,
    maxlength: 120
  },
  deals: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  }
}, {
  timestamps: true,
  collection: 'leadership_checkpoints'
});
schema.index({
  orgId: 1,
  createdAt: -1
});
export default mongoose.models.LeadershipCheckpoint || mongoose.model('LeadershipCheckpoint', schema);
