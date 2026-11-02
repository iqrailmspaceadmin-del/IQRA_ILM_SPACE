import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import admin from "firebase-admin";
import { createClient } from "@supabase/supabase-js";
import multer from "multer";
import { randomUUID } from "node:crypto";

const app = express();

const PORT = Number(process.env.PORT || 4000);

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const STORAGE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET || "learning-pdfs";

const ADMIN_FIREBASE_UIDS = (
  process.env.ADMIN_FIREBASE_UIDS || ""
)
  .split(",")
  .map((uid) => uid.trim())
  .filter(Boolean);

/* --------------------------------------------------
   BASIC SERVER CONFIGURATION
-------------------------------------------------- */

app.use(helmet());

app.use(
  express.json({
    limit: "1mb"
  })
);

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN ||
  "http://127.0.0.1:5500,http://localhost:5500"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow requests without an Origin header, such as health checks.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error("Origin not allowed by CORS.")
      );
    },

    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],

    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

/* --------------------------------------------------
   CHECK REQUIRED CONFIGURATION
-------------------------------------------------- */

if (!FIREBASE_PROJECT_ID) {
  console.error(
    "Missing FIREBASE_PROJECT_ID in backend .env"
  );

  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "Supabase configuration is incomplete. Database routes will return 503."
  );
}

/* --------------------------------------------------
   FIREBASE ADMIN INITIALIZATION
-------------------------------------------------- */

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: FIREBASE_PROJECT_ID
  });
}

/* --------------------------------------------------
   SUPABASE INITIALIZATION
-------------------------------------------------- */

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false
          }
        }
      )
    : null;

/* --------------------------------------------------
   VALID VALUES
-------------------------------------------------- */

const CATEGORIES = [
  "Islamic Studies",
  "Islamic Stories",
  "School Materials",
  "Career Guidance",
  "Awareness Programmes"
];

const CONTENT_TYPES = [
  "article",
  "pdf",
  "video",
  "external_link"
];

const STATUSES = [
  "draft",
  "published"
];

/* --------------------------------------------------
   AUTHENTICATION MIDDLEWARE
-------------------------------------------------- */

/*
  The frontend sends a Firebase ID token in:
  Authorization: Bearer <token>

  This middleware verifies the token with Firebase Admin.
*/
async function requireFirebaseUser(req, res, next) {
  const authorization = req.headers.authorization || "";

  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Sign-in required."
    });
  }

  try {
    req.firebaseUser = await admin
      .auth()
      .verifyIdToken(match[1], true);

    next();
  } catch (error) {
    console.error(
      "Firebase token verification failed:",
      error.message
    );

    return res.status(401).json({
      error: "Invalid or expired sign-in token."
    });
  }
}

/*
  Require a working Supabase configuration.
*/
function requireSupabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      error: "Backend database configuration is incomplete."
    });
  }

  next();
}

/*
  Administrator authorization is checked on the server.
*/
function requireAdmin(req, res, next) {
  const uid = req.firebaseUser.uid;

  if (!ADMIN_FIREBASE_UIDS.includes(uid)) {
    return res.status(403).json({
      error:
        "Administrator access denied. Check ADMIN_FIREBASE_UIDS in backend .env."
    });
  }

  next();
}

/* --------------------------------------------------
   PDF UPLOAD CONFIGURATION
-------------------------------------------------- */

const pdfUpload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1
  },

  fileFilter(req, file, callback) {
    const isPDF =
      file.mimetype === "application/pdf" &&
      file.originalname.toLowerCase().endsWith(".pdf");

    if (!isPDF) {
      return callback(
        new Error("Only PDF files are allowed.")
      );
    }

    callback(null, true);
  }
});

/* --------------------------------------------------
   HEALTH CHECK
-------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "iqra-ilm-space-api",
    databaseConfigured: Boolean(supabase)
  });
});

/* --------------------------------------------------
   STUDENT PROFILE
-------------------------------------------------- */

app.get(
  "/api/me",
  requireFirebaseUser,
  requireSupabase,
  async (req, res) => {
    try {
      const user = req.firebaseUser;

      const profile = {
        firebase_uid: user.uid,
        full_name: user.name || null,
        email: user.email || null,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("profiles")
        .upsert(profile, {
          onConflict: "firebase_uid"
        })
        .select(
          "id,firebase_uid,full_name,email,created_at"
        )
        .single();

      if (error) {
        console.error(
          "Profile upsert failed:",
          error.message
        );

        return res.status(500).json({
          error:
            "Could not load profile. Check the profiles table and database permissions."
        });
      }

      return res.json({
        profile: data
      });
    } catch (error) {
      console.error(
        "Profile endpoint failed:",
        error.message
      );

      return res.status(500).json({
        error: "Could not load student profile."
      });
    }
  }
);

/* --------------------------------------------------
   PUBLISHED LEARNING MATERIALS
-------------------------------------------------- */

app.get(
  "/api/materials",
  requireFirebaseUser,
  requireSupabase,
  async (req, res) => {
    try {
      const category =
        typeof req.query.category === "string"
          ? req.query.category.trim()
          : "";

      if (
        category &&
        !CATEGORIES.includes(category)
      ) {
        return res.status(400).json({
          error: "Invalid category filter."
        });
      }

      let query = supabase
        .from("learning_materials")
        .select(
          "id,title,description,category,subject,class_level,board,content_type,content_url,status,created_at,updated_at"
        )
        .eq("status", "published")
        .order("created_at", {
          ascending: false
        });

      if (category) {
        query = query.eq("category", category);
      }

      const { data, error } = await query;

      if (error) {
        console.error(
          "Materials query failed:",
          error.message
        );

        return res.status(500).json({
          error: "Could not load learning materials."
        });
      }

      const materials = (data || []).map((material) => {
        // PDF files are opened through the authenticated PDF endpoint;
        // never expose their Storage path or old public URL in the listing.
        if (material.content_type === "pdf") {
          return { ...material, content_url: null };
        }
        return material;
      });

      return res.json({
        materials,
        count: materials.length
      });
    } catch (error) {
      console.error(
        "Materials endpoint failed:",
        error.message
      );

      return res.status(500).json({
        error: "Could not load learning materials."
      });
    }
  }
);

/* --------------------------------------------------
   AUTHENTICATED PDF VIEWING
   Only signed-in users can view published PDF materials.
-------------------------------------------------- */

function getPrivateStoragePath(contentUrl) {
  if (typeof contentUrl !== "string" || !contentUrl.trim()) {
    return null;
  }

  const value = contentUrl.trim();

  // New records store the path directly, e.g. materials/example.pdf.
  if (!/^https?:\/\//i.test(value)) {
    if (!value.startsWith("materials/")) return null;
    if (value.split("/").some((part) => part === "..")) return null;
    return value;
  }

  // Support existing records that contain the old public Storage URL.
  try {
    const parsed = new URL(value);
    const configured = new URL(SUPABASE_URL);
    if (parsed.origin !== configured.origin) return null;

    const publicPrefix = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const signPrefix = `/storage/v1/object/sign/${STORAGE_BUCKET}/`;
    let encodedPath = null;

    if (parsed.pathname.startsWith(publicPrefix)) {
      encodedPath = parsed.pathname.slice(publicPrefix.length);
    } else if (parsed.pathname.startsWith(signPrefix)) {
      encodedPath = parsed.pathname.slice(signPrefix.length);
    }

    if (!encodedPath) return null;

    const path = encodedPath
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");

    if (!path.startsWith("materials/")) return null;
    if (path.split("/").some((part) => part === "..")) return null;
    return path;
  } catch {
    return null;
  }
}

app.get(
  "/api/materials/:id/pdf",
  requireFirebaseUser,
  requireSupabase,
  async (req, res) => {
    try {
      const { data: material, error: materialError } = await supabase
        .from("learning_materials")
        .select("id,title,content_type,content_url,status")
        .eq("id", req.params.id)
        .eq("status", "published")
        .eq("content_type", "pdf")
        .maybeSingle();

      if (materialError) {
        console.error("PDF material lookup failed:", materialError.message);
        return res.status(500).json({ error: "Could not find this PDF." });
      }

      if (!material) {
        return res.status(404).json({ error: "Published PDF not found." });
      }

      const storagePath = getPrivateStoragePath(material.content_url);
      if (!storagePath) {
        console.error("PDF record has an invalid or unsupported Storage path.");
        return res.status(404).json({ error: "PDF file is unavailable." });
      }

      const { data: file, error: downloadError } = await supabase
        .storage
        .from(STORAGE_BUCKET)
        .download(storagePath);

      if (downloadError || !file) {
        console.error(
          "Private PDF retrieval failed:",
          downloadError?.message || "File not found"
        );
        return res.status(404).json({
          error: "PDF file is unavailable. Check the Storage bucket and file path."
        });
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const safeTitle = String(material.title || "learning-material")
        .replace(/[^a-zA-Z0-9._ -]/g, "_")
        .slice(0, 100);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Length": String(buffer.length),
        "Content-Disposition": `inline; filename="${safeTitle}.pdf"`,
        "Cache-Control": "private, no-store, max-age=0",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });

      return res.status(200).send(buffer);
    } catch (error) {
      console.error("Authenticated PDF endpoint failed:", error.message);
      return res.status(500).json({ error: "Could not open this PDF." });
    }
  }
);

/* --------------------------------------------------
   ADMIN: LIST ALL MATERIALS
-------------------------------------------------- */

app.get(
  "/api/admin/materials",
  requireFirebaseUser,
  requireAdmin,
  requireSupabase,
  async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("learning_materials")
        .select("*")
        .order("created_at", {
          ascending: false
        });

      if (error) {
        console.error(
          "Admin materials query failed:",
          error.message
        );

        return res.status(500).json({
          error:
            "Could not load materials. Check the database schema."
        });
      }

      return res.json({
        materials: data || []
      });
    } catch (error) {
      console.error(error.message);

      return res.status(500).json({
        error: "Could not load admin materials."
      });
    }
  }
);

/* --------------------------------------------------
   MATERIAL VALIDATION
-------------------------------------------------- */

function validateMaterial(body) {
  if (
    !body.title ||
    !String(body.title).trim()
  ) {
    return "Title is required.";
  }

  if (!CATEGORIES.includes(body.category)) {
    return "Choose a valid category.";
  }

  if (!CONTENT_TYPES.includes(body.content_type)) {
    return "Choose a valid content type.";
  }

  if (
    !STATUSES.includes(body.status || "draft")
  ) {
    return "Status must be draft or published.";
  }

  if (
    body.content_type !== "pdf" &&
    !body.content_url
  ) {
    return "Resource URL is required.";
  }

  return null;
}

/* --------------------------------------------------
   ADMIN: ADD A LINK-BASED RESOURCE
-------------------------------------------------- */

app.post(
  "/api/admin/materials",
  requireFirebaseUser,
  requireAdmin,
  requireSupabase,
  async (req, res) => {
    try {
      const validationError =
        validateMaterial(req.body);

      if (validationError) {
        return res.status(400).json({
          error: validationError
        });
      }

      const body = req.body;

      const record = {
        title: String(body.title).trim(),
        description: body.description || null,
        category: body.category,
        subject: body.subject || null,
        class_level: body.class_level || null,
        board: body.board || null,
        content_type: body.content_type,
        content_url: body.content_url || null,
        status: body.status || "draft",
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("learning_materials")
        .insert(record)
        .select("*")
        .single();

      if (error) {
        console.error(
          "Insert material failed:",
          error.message
        );

        return res.status(500).json({
          error:
            "Could not save material. Check the learning_materials table."
        });
      }

      return res.status(201).json({
        material: data,
        message: "Learning material saved."
      });
    } catch (error) {
      console.error(error.message);

      return res.status(500).json({
        error: "Could not save learning material."
      });
    }
  }
);

/* --------------------------------------------------
   ADMIN: UPLOAD A PDF
-------------------------------------------------- */

app.post(
  "/api/admin/materials/upload",
  requireFirebaseUser,
  requireAdmin,
  requireSupabase,

  // Multer handles the incoming file.
  (req, res, next) => {
    pdfUpload.single("file")(
      req,
      res,
      (error) => {
        if (error) {
          return res.status(400).json({
            error: error.message
          });
        }

        next();
      }
    );
  },

  async (req, res) => {
    let uploadedObjectPath = null;

    try {
      const body = req.body;

      const validationError = validateMaterial({
        ...body,
        content_type: "pdf",
        content_url: "pending"
      });

      if (validationError) {
        return res.status(400).json({
          error: validationError
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Please choose a PDF file."
        });
      }

      const safeFileName = req.file.originalname
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(-120);

      uploadedObjectPath =
        `materials/${Date.now()}-${randomUUID()}-${safeFileName}`;

      /*
        Upload the PDF to the Supabase Storage bucket.
        The service-role key remains on the backend.
      */
      const { error: uploadError } = await supabase
        .storage
        .from(STORAGE_BUCKET)
        .upload(
          uploadedObjectPath,
          req.file.buffer,
          {
            contentType: "application/pdf",
            upsert: false
          }
        );

      if (uploadError) {
        console.error(
          "Storage upload failed:",
          uploadError.message
        );

        return res.status(500).json({
          error:
            "PDF upload failed. Check the Supabase bucket and backend configuration."
        });
      }

      /*
        This starter implementation expects the bucket to be public.
        For private PDFs, use an authenticated download endpoint
        or short-lived signed URLs instead.
      */
      const privateStoragePath = uploadedObjectPath;

      const record = {
        title: String(body.title).trim(),
        description: body.description || null,
        category: body.category,
        subject: body.subject || null,
        class_level: body.class_level || null,
        board: body.board || null,
        content_type: "pdf",
        content_url: privateStoragePath,
        status: STATUSES.includes(body.status)
          ? body.status
          : "draft",
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("learning_materials")
        .insert(record)
        .select("*")
        .single();

      if (error) {
        console.error(
          "Saving PDF record failed:",
          error.message
        );

        /*
          The file may remain in Storage if the database insert
          fails. Remove that orphaned file manually if necessary.
        */
        return res.status(500).json({
          error:
            "PDF uploaded, but its database record could not be saved. Check the learning_materials schema."
        });
      }

      return res.status(201).json({
        material: data,
        message: "PDF uploaded and learning material saved."
      });
    } catch (error) {
      console.error(
        "PDF upload endpoint failed:",
        error.message
      );

      return res.status(500).json({
        error: "PDF upload failed."
      });
    }
  }
);

/* --------------------------------------------------
   ADMIN: UPDATE A MATERIAL
-------------------------------------------------- */

app.patch(
  "/api/admin/materials/:id",
  requireFirebaseUser,
  requireAdmin,
  requireSupabase,
  async (req, res) => {
    try {
      const body = req.body || {};
      const updates = {};

      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) {
          return res.status(400).json({
            error: "Status must be draft or published."
          });
        }
        updates.status = body.status;
      }

      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (!title) {
          return res.status(400).json({
            error: "Title cannot be empty."
          });
        }
        updates.title = title.slice(0, 250);
      }

      if (body.description !== undefined) {
        updates.description = String(body.description || "").trim().slice(0, 5000) || null;
      }

      if (body.category !== undefined) {
        if (!CATEGORIES.includes(body.category)) {
          return res.status(400).json({
            error: "Choose a valid category."
          });
        }
        updates.category = body.category;
      }

      for (const field of ["subject", "class_level", "board"]) {
        if (body[field] !== undefined) {
          updates[field] = String(body[field] || "").trim().slice(0, 150) || null;
        }
      }

      if (!Object.keys(updates).length) {
        return res.status(400).json({
          error: "No supported changes were supplied."
        });
      }

      updates.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("learning_materials")
        .update(updates)
        .eq("id", req.params.id)
        .select("*")
        .maybeSingle();

      if (error) {
        console.error("Material update failed:", error.message);
        return res.status(500).json({
          error: "Could not update material."
        });
      }

      if (!data) {
        return res.status(404).json({
          error: "Learning material not found."
        });
      }

      return res.json({
        material: data,
        message: "Learning material updated."
      });
    } catch (error) {
      console.error("Material update error:", error.message);
      return res.status(500).json({
        error: "Could not update material."
      });
    }
  }
);

/* --------------------------------------------------
   ADMIN: DELETE A MATERIAL AND ITS STORED PDF
-------------------------------------------------- */

app.delete(
  "/api/admin/materials/:id",
  requireFirebaseUser,
  requireAdmin,
  requireSupabase,
  async (req, res) => {
    try {
      // Read the record first so we know which Storage object belongs to it.
      const { data: material, error: lookupError } = await supabase
        .from("learning_materials")
        .select("id,content_type,content_url")
        .eq("id", req.params.id)
        .maybeSingle();

      if (lookupError) {
        console.error("Material lookup before deletion failed:", lookupError.message);
        return res.status(500).json({
          error: "Could not find the material to delete."
        });
      }

      if (!material) {
        return res.status(404).json({
          error: "Learning material not found."
        });
      }

      // Delete the database record first. This avoids leaving a live record
      // that points to a file already deleted from Storage.
      const { error: deleteError } = await supabase
        .from("learning_materials")
        .delete()
        .eq("id", material.id);

      if (deleteError) {
        console.error("Material deletion failed:", deleteError.message);
        return res.status(500).json({
          error: "Could not delete material."
        });
      }

      let storageCleanupWarning = null;

      if (material.content_type === "pdf" && material.content_url) {
        const storagePath = getPrivateStoragePath(material.content_url);

        if (storagePath) {
          const { error: storageError } = await supabase
            .storage
            .from(STORAGE_BUCKET)
            .remove([storagePath]);

          if (storageError) {
            console.error("PDF Storage cleanup failed:", storageError.message);
            storageCleanupWarning =
              "The material record was deleted, but the PDF file could not be removed from Storage.";
          }
        } else {
          storageCleanupWarning =
            "The material record was deleted, but its PDF Storage path could not be identified.";
        }
      }

      return res.json({
        ok: true,
        message: "Learning material deleted.",
        ...(storageCleanupWarning ? { warning: storageCleanupWarning } : {})
      });
    } catch (error) {
      console.error("Material deletion error:", error.message);
      return res.status(500).json({
        error: "Could not delete material."
      });
    }
  }
);

/* --------------------------------------------------
   CENTRAL ERROR HANDLER
-------------------------------------------------- */

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (
    error.message === "Origin not allowed by CORS."
  ) {
    return res.status(403).json({
      error: "This website origin is not allowed."
    });
  }

  console.error(
    "Unexpected server error:",
    error.message
  );

  return res.status(500).json({
    error: "An unexpected server error occurred."
  });
});

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */


/* --------------------------------------------------
   IQRA ILM SPACE ADMIN DASHBOARD + ACTIVITY API
   Requires the SQL migration in supabase_migration.sql.
-------------------------------------------------- */

app.get("/api/admin/dashboard", requireFirebaseUser, requireAdmin, requireSupabase, async (req, res) => {
  try {
    const [students, subscriptions, payments, materials, views, recentViews] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("subscriptions").select("id,status,expires_at", { count: "exact" }),
      supabase.from("payments").select("id,status,amount_inr,created_at", { count: "exact" }).order("created_at", { ascending: false }).limit(10),
      supabase.from("learning_materials").select("id", { count: "exact", head: true }),
      supabase.from("pdf_view_events").select("id", { count: "exact", head: true }),
      supabase.from("pdf_view_events").select("id,student_name,student_email,material_title,viewed_at").order("viewed_at", { ascending: false }).limit(10)
    ]);
    for (const result of [students, subscriptions, payments, materials, views, recentViews]) {
      if (result.error) throw result.error;
    }
    const allSubs = subscriptions.data || [];
    const now = Date.now();
    const active = allSubs.filter(s => s.status === "active" && (!s.expires_at || new Date(s.expires_at).getTime() > now)).length;
    const expired = allSubs.filter(s => s.status === "expired" || (s.expires_at && new Date(s.expires_at).getTime() <= now)).length;
    const expiringSoon = allSubs.filter(s => s.status === "active" && s.expires_at && new Date(s.expires_at).getTime() > now && new Date(s.expires_at).getTime() <= now + 7*86400000).length;
    res.json({
      totals: { students: students.count || 0, active_subscriptions: active, expired_subscriptions: expired, expiring_soon: expiringSoon, materials: materials.count || 0, pdf_views: views.count || 0 },
      recent_payments: payments.data || [],
      recent_views: recentViews.data || []
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({ error: "Could not load admin dashboard. Check that the SQL migration has been applied." });
  }
});

app.get("/api/admin/students", requireFirebaseUser, requireAdmin, requireSupabase, async (req, res) => {
  try {
    const [profiles, subs] = await Promise.all([
      supabase.from("profiles").select("id,firebase_uid,full_name,email,created_at").order("created_at", { ascending: false }),
      supabase.from("subscriptions").select("id,firebase_uid,status,plan_name,amount_inr,started_at,expires_at,updated_at")
    ]);
    if (profiles.error) throw profiles.error;
    if (subs.error) throw subs.error;
    const byUid = new Map((subs.data || []).map(s => [s.firebase_uid, s]));
    res.json({ students: (profiles.data || []).map(p => ({ ...p, subscription: byUid.get(p.firebase_uid) || null })) });
  } catch (error) {
    console.error("Admin students error:", error);
    res.status(500).json({ error: "Could not load students." });
  }
});

app.get("/api/admin/activity", requireFirebaseUser, requireAdmin, requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabase.from("pdf_view_events")
      .select("id,student_name,student_email,material_id,material_title,viewed_at")
      .order("viewed_at", { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ activity: data || [] });
  } catch (error) {
    console.error("Admin activity error:", error);
    res.status(500).json({ error: "Could not load PDF activity." });
  }
});

app.get("/api/admin/payments", requireFirebaseUser, requireAdmin, requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabase.from("payments")
      .select("id,firebase_uid,student_name,student_email,provider,provider_payment_id,amount_inr,currency,status,invoice_number,created_at")
      .order("created_at", { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ payments: data || [] });
  } catch (error) {
    console.error("Admin payments error:", error);
    res.status(500).json({ error: "Could not load payments." });
  }
});

app.patch("/api/admin/subscriptions/:id", requireFirebaseUser, requireAdmin, requireSupabase, async (req, res) => {
  try {
    const { status, expires_at, started_at, plan_name, amount_inr } = req.body || {};
    const patch = {};
    if (["active", "expired", "cancelled", "pending"].includes(status)) patch.status = status;
    if (expires_at !== undefined) patch.expires_at = expires_at || null;
    if (started_at !== undefined) patch.started_at = started_at || null;
    if (typeof plan_name === "string") patch.plan_name = plan_name.slice(0, 120);
    if (amount_inr !== undefined && Number.isFinite(Number(amount_inr))) patch.amount_inr = Number(amount_inr);
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("subscriptions").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ subscription: data });
  } catch (error) {
    console.error("Subscription update error:", error);
    res.status(500).json({ error: "Could not update subscription." });
  }
});

app.post("/api/activity/pdf-view", requireFirebaseUser, requireSupabase, async (req, res) => {
  try {
    const materialId = String(req.body?.material_id || "");
    if (!materialId) return res.status(400).json({ error: "material_id is required." });
    const { data: material, error: materialError } = await supabase.from("learning_materials")
      .select("id,title,content_type,status").eq("id", materialId).eq("status", "published").single();
    if (materialError || !material || material.content_type !== "pdf") {
      return res.status(404).json({ error: "Published PDF not found." });
    }
    const u = req.firebaseUser || {};
    const { error } = await supabase.from("pdf_view_events").insert({
      firebase_uid: u.uid,
      student_name: u.name || u.displayName || null,
      student_email: u.email || null,
      material_id: material.id,
      material_title: material.title
    });
    if (error) throw error;
    res.status(201).json({ recorded: true });
  } catch (error) {
    console.error("PDF view tracking error:", error);
    res.status(500).json({ error: "Could not record PDF view." });
  }
});

app.post("/api/enquiries", requireSupabase, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim().slice(0, 150);
    const email = String(req.body?.email || "").trim().slice(0, 254);
    const topic = String(req.body?.topic || "General enquiry").trim().slice(0, 150);
    const message = String(req.body?.message || "").trim().slice(0, 5000);
    if (!name || !email || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter your name, valid email, and message." });
    }
    const { error } = await supabase.from("enquiries").insert({ name, email, topic, message });
    if (error) throw error;
    res.status(201).json({ message: "Your enquiry has been received." });
  } catch (error) {
    console.error("Enquiry submission error:", error);
    res.status(500).json({ error: "Could not submit enquiry." });
  }
});


app.listen(PORT, () => {
  console.log(
    `IQRA ILM SPACE API listening on port ${PORT}`
  );
});