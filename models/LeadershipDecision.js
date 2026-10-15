import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  dealId: {
    type: String,
    required: true,
    maxlength: 100
  },
  dealName: {
    type: String,
    required: true
  },
  text: {
    type: String,
    required: true,
    maxlength: 4000
  },
  reasoning: {
    type: String,
    required: true,
    maxlength: 2000
  },
  expectedResult: {
    type: String,
    required: true,
    maxlength: 1000
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
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  authorName: {
    type: String,
    required: true
  },
  evidence: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  sourceMode: {
    type: String,
    enum: ['demo', 'live'],
    required: true
  },
  sourceAccountKey: {
    type: String,
    maxlength: 500
  },
  sourceEntryId: {
    type: String,
    maxlength: 100
  },
  sourceDecidedAt: Date,
  sourceAuthorId: mongoose.Schema.Types.ObjectId,
  sourceAuthorName: {
    type: String,
    maxlength: 300
  },
  actionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RecoveryAction'
  }],
  reviewCount: {
    type: Number,
    default: 0
  },
  latestReviewAt: {
    type: Date,
    default: null
  },
  reviews: [{
    assessment: {
      type: String,
      enum: ['improved', 'unchanged', 'worsened', 'insufficient_evidence'],
      required: true
    },
    note: {
      type: String,
      required: true,
      maxlength: 2000
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
    },
    evidence: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  }]
}, {
  timestamps: true,
  collection: 'leadership_decisions'
});
schema.index({
  orgId: 1,
  createdAt: -1
});
schema.index({
  orgId: 1,
  sourceEntryId: 1
}, {
  unique: true,
  partialFilterExpression: {
    sourceEntryId: {
      $type: 'string'
    }
  }
});
export default mongoose.models.LeadershipDecision || mongoose.model('LeadershipDecision', schema);
