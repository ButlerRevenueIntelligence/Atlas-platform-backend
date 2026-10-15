import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  accountKey: {
    type: String,
    required: true,
    maxlength: 500
  },
  objective: {
    type: String,
    required: true,
    maxlength: 2000
  },
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  ownerName: {
    type: String,
    required: true
  },
  reviewAt: {
    type: Date,
    default: null
  },
  stakeholders: [{
    name: {
      type: String,
      required: true,
      maxlength: 150
    },
    title: {
      type: String,
      maxlength: 150
    },
    role: {
      type: String,
      enum: ['economic_buyer', 'champion', 'technical', 'legal', 'procurement', 'other'],
      required: true
    },
    engagement: {
      type: String,
      enum: ['unknown', 'not_contacted', 'engaged', 'aligned'],
      default: 'unknown'
    },
    notes: {
      type: String,
      maxlength: 1000
    }
  }],
  blockers: [{
    text: {
      type: String,
      required: true,
      maxlength: 1000
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null
    },
    ownerName: {
      type: String,
      default: ''
    },
    status: {
      type: String,
      enum: ['open', 'resolved'],
      default: 'open'
    }
  }],
  history: [{
    kind: {
      type: String,
      enum: ['plan_updated', 'note', 'decision'],
      required: true
    },
    text: {
      type: String,
      required: true,
      maxlength: 4000
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    authorName: {
      type: String,
      required: true
    },
    at: {
      type: Date,
      required: true
    }
  }],
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  }
}, {
  timestamps: true,
  collection: 'account_action_plans'
});
schema.index({
  orgId: 1,
  accountKey: 1
}, {
  unique: true
});
export default mongoose.models.AccountActionPlan || mongoose.model('AccountActionPlan', schema);
