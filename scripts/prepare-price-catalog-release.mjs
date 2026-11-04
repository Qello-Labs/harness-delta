// Local files only; this command does not create a tag, commit, release or network request.
import { constants } from 'node:fs';
import { mkdir,open,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';

try {
  const [catalogPath,outputPath,...extra]=process.argv.slice(2);
  if(!catalogPath||!outputPath||extra.length)throw new Error('usage_catalog_file_output_directory');
  const {preparePriceCatalogRelease}=await import('../dist/pricing/price-catalog-release.js');
  const file=await open(catalogPath,constants.O_RDONLY|constants.O_NONBLOCK);
  let bytes;
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.size>1024*1024)throw new Error('invalid_catalog_file');
    const buffer=Buffer.alloc(1024*1024+1);let size=0;
    while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead;}
    if(size>1024*1024)throw new Error('invalid_catalog_file');bytes=buffer.subarray(0,size);
  } finally {await file.close();}
  const release=preparePriceCatalogRelease(bytes);const directory=resolve(outputPath);
  await mkdir(directory,{recursive:true});
  for(const [name,content] of [[release.manifest.artifact_file,release.artifact],['manifest.json',Buffer.from(JSON.stringify(release.manifest,null,2)+'\n')]]) {
    const destination=join(directory,name);
    try {await writeFile(destination,content,{flag:'wx'});}
    catch(error){if(error?.code!=='EEXIST'||!(await readFile(destination)).equals(content))throw new Error('catalog_release_output_conflict',{cause:error});}
  }
  process.stdout.write(JSON.stringify(release.manifest,null,2)+'\n');
} catch(error) {
  process.stderr.write(error instanceof Error&&/^[a-z][a-z0-9_]{1,63}$/.test(error.message)?error.message+'\n':'catalog_release_preparation_failed\n');process.exitCode=2;
}
