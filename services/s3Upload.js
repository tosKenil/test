const AWS = require('aws-sdk');
// const logger = require('../utils/logger').logger;

// INIT CONFIGS
const s3Public = new AWS.S3({
   accessKeyId: process.env.S3_ACCESS_KEY,
   secretAccessKey: process.env.S3_SECRET_KEY,
   region: process.env.S3_REGION
});

const s3Private = new AWS.S3({
   accessKeyId: process.env.S3_ACCESS_KEY,
   secretAccessKey: process.env.S3_SECRET_KEY,
   region: process.env.AWS_PRIVATE_REGION
});

const spacesEndpoint = new AWS.Endpoint(process.env.SPACES_ENDPOINT || '');

const s3Spaces = new AWS.S3({
   endpoint: spacesEndpoint,
   accessKeyId: process.env.SPACES_ACCESS_KEY,
   secretAccessKey: process.env.SPACES_SECRET_KEY,
   signatureVersion: 'v4',
   region: process.env.SPACES_REGION
});

const publicBucket = process.env.S3_PUBLIC_BUCKET_NAME;
const privateBucket = process.env.S3_PRIVATE_BUCKET_NAME;
const spacesBucket = process.env.SPACES_RECORDING_BUCKET;
const spacesFolder = process.env.SPACES_PROJECT_FOLDER || '';


function uploadFile(filepath, filename, filedata, isPublic, mimetype) {
   return new Promise(function (resolve, reject) {
      try {
         var bucketName = isPublic ? publicBucket : privateBucket;
         var s3 = isPublic ? s3Public : s3Private;

         var params = {
            Bucket: bucketName,
            Key: filepath + filename,
            Body: filedata,
            ContentType: mimetype
         };

         s3.upload(params, function (err, data) {
            if (err) {
               // logger.error(__filename, 'uploadFile', '', '' + err, '' + err);
               return reject(new Error('Could not upload file'));
            }
            resolve(data);
         });
      } catch (err) {
         reject(new Error('Could not upload file'));
      }
   });
}


function getFilePath(filename, time, isPublic, bucketName) {
   return new Promise(function (resolve, reject) {
      try {
         var Bucket = bucketName || (isPublic ? publicBucket : privateBucket);
         var s3 = isPublic ? s3Public : s3Private;

         s3.getSignedUrl(
            'getObject',
            {
               Bucket: Bucket,
               Key: filename,
               Expires: time
            },
            function (err, url) {
               if (err) return reject(err);
               resolve(url);
            }
         );
      } catch (err) {
         reject(err);
      }
   });
}


function deleteFile(filename, isPublic) {
   return new Promise(function (resolve, reject) {
      try {
         var bucketName = isPublic ? publicBucket : privateBucket;
         var s3 = isPublic ? s3Public : s3Private;

         var params = {
            Bucket: bucketName,
            Key: filename
         };

         s3.deleteObject(params, function (err, data) {
            if (err) return reject(new Error('Could not delete file'));
            resolve(data);
         });
      } catch (err) {
         reject(new Error('Could not delete file'));
      }
   });
}


function getFileObject(filename, isPublic) {
   return new Promise(function (resolve, reject) {
      try {
         var s3 = isPublic ? s3Public : s3Private;
         var bucketName = isPublic ? publicBucket : privateBucket;

         s3.getObject(
            {
               Bucket: bucketName,
               Key: filename
            },
            function (err, data) {
               if (err) return reject(err);
               resolve(data);
            }
         );
      } catch (err) {
         reject(err);
      }
   });
}


function uploadToSpaces(options) {
   return new Promise(function (resolve, reject) {
      try {
         var prefix = spacesFolder ? spacesFolder + '/' : '';

         var params = {
            Bucket: spacesBucket,
            Key: prefix + options.filepath + options.filename,
            Body: options.fileData,
            ACL: 'public-read',
            ContentType: options.mimetype
         };

         s3Spaces.upload(params, function (err, data) {
            if (err) {
               // logger.error(__filename, 'uploadToSpaces', '', '' + err, '' + err);
               return reject(new Error('Could not upload file to space'));
            }
            resolve(data);
         });
      } catch (err) {
         reject(new Error('Could not upload file to space'));
      }
   });
}
// const { BlobServiceClient } = require('@azure/storage-blob');

// const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);

// const containerName = process.env.AZURE_CONTAINER_NAME || 'storage';

// async function getContainerClient() {
//    const containerClient = blobServiceClient.getContainerClient(containerName);
//    const exists = await containerClient.exists();
//    if (!exists) {
//       await containerClient.create({ access: 'container' }); // public
//    }
//    return containerClient;
// }


// async function uploadToSpaces(options) {
//    try {
//       const containerClient = await getContainerClient();

//       const blobPath = `${options.filepath || ''}${options.filename}`;

//       const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

//       await blockBlobClient.uploadData(options.fileData, {
//          blobHTTPHeaders: {
//             blobContentType: options.mimetype || 'application/octet-stream'
//          }
//       });

//       return {
//          url: blockBlobClient.url,
//          blobName: blobPath,
//          container: containerName
//       };
//    } catch (err) {
//       console.error('Azure upload error:', err);
//       throw new Error('Could not upload file to Azure Blob Storage');
//    }
// }


module.exports = { uploadFile, getFilePath, deleteFile, getFileObject, uploadToSpaces };
