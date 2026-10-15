import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  orgId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  period: {
    type: String,
    required: true
  },
  metric: {
    type: String,
    enum: ['bookings', 'stripe', 'shopify', 'metrics_daily', 'sample_revenue'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    enum: ['USD'],
    default: 'USD'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  history: [{
    amount: Number,
    at: Date,
    userId: mongoose.Schema.Types.ObjectId
  }]
}, {
  timestamps: true,
  collection: 'revenue_targets'
});
schema.index({
  orgId: 1,
  period: 1,
  metric: 1
}, {
  unique: true
});
export default mongoose.models.RevenueTarget || mongoose.model('RevenueTarget', schema);
