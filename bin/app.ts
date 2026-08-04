#!/usr/bin/env node
// Thin entrypoint — all wiring lives in lib/build-app.ts so tests can synth
// the exact same stack graph.
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app';
import { loadConfig } from '../lib/load-config';

const app = new cdk.App();
buildApp(app, loadConfig(app));
