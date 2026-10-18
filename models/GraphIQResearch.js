import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  kind: {
    type: String,
    enum: ['companies', 'news'],
    required: true
  },
  query: {
    type: String,
    required: true,
    maxlength: 500
  },
  tool: {
    type: String,
    required: true
  },
  records: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  text: {
    type: String,
    maxlength: 20000,
    default: ''
  },
  expiresAt: {
    type: Date,
    required: true,
    index: {
      expires: 0
    }
  }
}, {
  timestamps: true,
  collection: 'graphiq_research'
});
schema.index({
  orgId: 1,
  kind: 1,
  createdAt: -1
});
export default mongoose.models.GraphIQResearch || mongoose.model('GraphIQResearch', schema);
