// backend/models/IntegrationConnection.js

import mongoose from "mongoose";

import {
  encryptIntegrationToken,
  decryptIntegrationToken,
} from "../utils/tokenCrypto.js";

const IntegrationConnectionSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    provider: {
      type: String,
      required: true,
      enum: [
        "hubspot",
        "salesforce",
        "google_ads",
        "meta_ads",
        "linkedin_ads",
        "ga4",
        "stripe",
        "shopify",
        "zoho_crm",
        "pipedrive",
        "bitrix24",
      ],
      index: true,
    },

    status: {
      type: String,
      enum: [
        "connected",
        "disconnected",
        "error",
        "syncing",
      ],
      default: "disconnected",
      index: true,
    },

    mode: {
      type: String,
      enum: ["demo", "live"],
      default: "demo",
      index: true,
    },

    externalAccountId: {
      type: String,
      default: null,
      index: true,
    },

    externalAccountName: {
      type: String,
      default: null,
    },

    /*
     * OAuth tokens are encrypted before MongoDB storage
     * and decrypted automatically when accessed through
     * a Mongoose document.
     *
     * select: false prevents normal queries from
     * returning the fields unless explicitly requested.
     */
    accessToken: {
      type: String,
      default: null,
      select: false,

      set(value) {
        return encryptIntegrationToken(value);
      },

      get(value) {
        return decryptIntegrationToken(value);
      },
    },

    refreshToken: {
      type: String,
      default: null,
      select: false,

      set(value) {
        return encryptIntegrationToken(value);
      },

      get(value) {
        return decryptIntegrationToken(value);
      },
    },

    tokenType: {
      type: String,
      default: null,
    },

    tokenExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    scopes: {
      type: [String],
      default: [],
    },

    connectedAt: {
      type: Date,
      default: null,
    },

    disconnectedAt: {
      type: Date,
      default: null,
    },

    lastSyncAt: {
      type: Date,
      default: null,
    },

    lastSyncStatus: {
      type: String,
      enum: [
        "never",
        "success",
        "failed",
        "running",
      ],
      default: "never",
      index: true,
    },

    lastError: {
      type: String,
      default: null,
    },

    syncCursor: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,

    /*
     * Keep getters enabled when a document is converted
     * to an object internally.
     *
     * Token fields remain select:false, so they are not
     * exposed through ordinary API responses.
     */
    toObject: {
      getters: true,
    },

    toJSON: {
      getters: true,
    },
  }
);

/*
 * One connection per provider per Atlas workspace.
 */
IntegrationConnectionSchema.index(
  {
    orgId: 1,
    provider: 1,
  },
  {
    unique: true,
  }
);

/* -------------------------------- */
/* Connection lifecycle helpers     */
/* -------------------------------- */

IntegrationConnectionSchema.methods.markConnected =
  function ({
    mode = "live",
    externalAccountId = null,
    externalAccountName = null,
    accessToken = null,
    refreshToken = null,
    tokenType = null,
    tokenExpiresAt = null,
    scopes = [],
    metadata = {},
  } = {}) {
    this.status = "connected";
    this.mode = mode;

    this.externalAccountId =
      externalAccountId;

    this.externalAccountName =
      externalAccountName;

    /*
     * Mongoose setters automatically encrypt these.
     */
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;

    this.tokenType = tokenType;

    this.tokenExpiresAt =
      tokenExpiresAt;

    this.scopes = Array.isArray(scopes)
      ? scopes
      : [];

    this.connectedAt = new Date();
    this.disconnectedAt = null;

    this.lastSyncAt = new Date();
    this.lastSyncStatus = "success";
    this.lastError = null;

    this.metadata = {
      ...(this.metadata || {}),
      ...(metadata || {}),
    };

    return this;
  };

/* -------------------------------- */
/* Disconnect helper                */
/* -------------------------------- */

IntegrationConnectionSchema.methods.markDisconnected =
  function () {
    this.status = "disconnected";
    this.mode = "demo";

    /*
     * Removing the tokens does not require encryption.
     */
    this.accessToken = null;
    this.refreshToken = null;

    this.tokenType = null;
    this.tokenExpiresAt = null;

    this.externalAccountId = null;
    this.externalAccountName = null;

    this.scopes = [];

    this.disconnectedAt =
      new Date();

    this.lastSyncStatus = "never";
    this.lastSyncAt = null;
    this.lastError = null;

    this.syncCursor = null;
    this.settings = {};
    this.metadata = {};

    return this;
  };

/* -------------------------------- */
/* Sync lifecycle helpers           */
/* -------------------------------- */

IntegrationConnectionSchema.methods.markSyncRunning =
  function () {
    this.status = "syncing";
    this.lastSyncStatus = "running";
    this.lastError = null;

    return this;
  };

IntegrationConnectionSchema.methods.markSyncSuccess =
  function ({
    syncCursor = null,
    metadata = {},
  } = {}) {
    this.status = "connected";

    this.lastSyncAt = new Date();
    this.lastSyncStatus = "success";
    this.lastError = null;

    if (syncCursor !== null) {
      this.syncCursor = syncCursor;
    }

    this.metadata = {
      ...(this.metadata || {}),
      ...(metadata || {}),
    };

    return this;
  };

IntegrationConnectionSchema.methods.markSyncFailed =
  function (errorMessage) {
    this.status = "error";
    this.lastSyncStatus = "failed";

    this.lastError =
      errorMessage ||
      "Unknown sync error";

    return this;
  };

const IntegrationConnection =
  mongoose.models.IntegrationConnection ||
  mongoose.model(
    "IntegrationConnection",
    IntegrationConnectionSchema,
    "integration_connections"
  );

export default IntegrationConnection;
