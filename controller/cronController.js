const { MongoClient } = require("mongodb");

const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

function getTodayDate() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}

function extractDbNameFromUri(uri) {
    const url = new URL(uri);
    return url.pathname.replace("/", "") || null;
}


const backupDatabaseToLocal = async () => {
    let sourceUri = process.env.DB_URL;
    let targetUri = process.env.MONGO_BACKUP_URL || "mongodb://localhost:27017/";

    const sourceClient = new MongoClient(sourceUri);
    const targetClient = new MongoClient(targetUri);

    try {
        await sourceClient.connect();
        await targetClient.connect();

        // 4️⃣ auto-detect source DB name
        const sourceDBName = extractDbNameFromUri(sourceUri);
        if (!sourceDBName) {
            throw new Error("Source DB name not found in URI");
        }

        // 1️⃣ auto-generate backup DB name
        const today = getTodayDate();
        const backupDBName = `${sourceDBName}_backup_${today}`;

        const targetAdmin = targetClient.db().admin();
        const existingDbs = await targetAdmin.listDatabases();

        // 2️⃣ if backup DB already exists → return
        const alreadyExists = existingDbs.databases.some(
            (db) => db.name === backupDBName
        );

        if (alreadyExists) {
            console.log(`⚠️ Backup DB already exists: ${backupDBName}`);
            return;
        }

        console.log(`📦 Creating backup DB: ${backupDBName}`);

        const sourceDb = sourceClient.db(sourceDBName);
        const targetDb = targetClient.db(backupDBName);

        const collections = await sourceDb.listCollections().toArray();

        console.log(`📚 Found ${collections.length} collections`);

        for (const col of collections) {
            const name = col.name;

            console.log(`➡️ Processing collection: ${name}`);

            const sourceCol = sourceDb.collection(name);
            const targetCol = targetDb.collection(name);

            await targetDb.createCollection(name);

            const cursor = sourceCol.find({});
            const batchSize = 1000;
            let batch = [];

            for await (const doc of cursor) {
                batch.push(doc);

                if (batch.length === batchSize) {
                    await targetCol.insertMany(batch);
                    batch = [];
                }
            }

            if (batch.length > 0) {
                await targetCol.insertMany(batch);
            }

            const indexes = await sourceCol.indexes();

            for (const index of indexes) {
                if (index.name === "_id_") continue;

                const { key, name: idxName, ...options } = index;
                await targetCol.createIndex(key, {
                    name: idxName,
                    ...options,
                });
            }

            console.log(`✅ Completed: ${name}`);
        }

        console.log("🎉 Backup completed successfully");
    } catch (err) {
        console.error("❌ Backup failed:", err);
    } finally {
        await sourceClient.close();
        await targetClient.close();
    }
}

const spacesEndpoint = new AWS.Endpoint('blr1.digitaloceanspaces.com');

const s3 = new AWS.S3({
    endpoint: spacesEndpoint,
    accessKeyId: process.env.SPACES_ACCESS_KEY,
    secretAccessKey: process.env.SPACES_SECRET_KEY,
    s3ForcePathStyle: true,
    signatureVersion: 'v4'
});

const BUCKET_NAME = process.env.SPACES_RECORDING_BUCKET;

const backupDocs = async (req, res) => {
    try {

        const fileName = `backup-ttsign-${Date.now()}.zip`;
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        let allFiles = [];
        let listParams = { Bucket: BUCKET_NAME };
        let isTruncated = true;

        while (isTruncated) {
            const data = await s3.listObjectsV2(listParams).promise();
            if (data.Contents) {
                allFiles.push(...data.Contents);
            }

            if (data.IsTruncated) {
                listParams.ContinuationToken = data.NextContinuationToken;
            } else {
                isTruncated = false;
            }
        }

        if (allFiles.length === 0) {
            return res.status(404).send("space is blank");
        }

        for (const file of allFiles) {
            const fileStream = s3.getObject({
                Bucket: BUCKET_NAME,
                Key: file.Key
            }).createReadStream();

            archive.append(fileStream, { name: file.Key });

            fileStream.on('error', (err) => {
                console.error(`Error with file ${file.Key}:`, err);
            });
        }

        await archive.finalize();

    } catch (error) {
        console.error("error:", error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    }
};


module.exports = { backupDatabaseToLocal, backupDocs }