/**
 * ECS Fargate Infrastructure with Blue/Green Deployments
 * 
 * This CDK stack creates:
 * - ECS Fargate cluster with PostgreSQL and application services
 * - Blue/Green deployments using AWS CodeDeploy
 * - Maximum timeout values for deployment safety
 * - Dual load balancer listeners (production:80, test:42069)
 * - Auto-rollback configuration on deployment failures
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

export class EcsInfrastructureStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Create VPC
        const vpc = new ec2.Vpc(this, 'EcsVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });
        vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create ECS Cluster
        const cluster = new ecs.Cluster(this, 'EcsCluster', {
            vpc,
            clusterName: 'ponder-cluster',
        });
        cluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Security Group for PostgreSQL
        const postgresSecurityGroup = new ec2.SecurityGroup(this, 'PostgresSecurityGroup', {
            vpc,
            description: 'Security group for PostgreSQL service',
            allowAllOutbound: true,
        });
        postgresSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Security Group for Application
        const appSecurityGroup = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
            vpc,
            description: 'Security group for application service',
            allowAllOutbound: true,
        });
        appSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Allow app to connect to postgres on port 5432
        postgresSecurityGroup.addIngressRule(
            appSecurityGroup,
            ec2.Port.tcp(5432),
            'Allow app to connect to PostgreSQL'
        );

        // Allow ALB to connect to app
        appSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(42069),
            'Allow ALB to connect to app'
        );

        // CloudWatch Log Groups
        const postgresLogGroup = new logs.LogGroup(this, 'PostgresLogGroup', {
            logGroupName: '/ecs/postgres',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const appLogGroup = new logs.LogGroup(this, 'AppLogGroup', {
            logGroupName: '/ecs/app',
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // PostgreSQL Task Definition
        const postgresTaskDefinition = new ecs.FargateTaskDefinition(this, 'PostgresTaskDefinition', {
            memoryLimitMiB: 1024,
            cpu: 512,
        });
        postgresTaskDefinition.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const postgresContainer = postgresTaskDefinition.addContainer('postgres', {
            image: ecs.ContainerImage.fromRegistry('postgres:15-alpine'),
            environment: {
                POSTGRES_DB: 'ponder',
                POSTGRES_USER: 'ponder',
                POSTGRES_PASSWORD: 'ponder123', // In production, use Secrets Manager
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'postgres',
                logGroup: postgresLogGroup,
            }),
            healthCheck: {
                command: ['CMD-SHELL', 'pg_isready -U ponder'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
            },
        });

        postgresContainer.addPortMappings({
            containerPort: 5432,
            protocol: ecs.Protocol.TCP,
        });

        // PostgreSQL Service
        const postgresService = new ecs.FargateService(this, 'PostgresService', {
            cluster,
            taskDefinition: postgresTaskDefinition,
            desiredCount: 1,
            serviceName: 'postgres-service',
            securityGroups: [postgresSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
        });
        postgresService.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Application Task Definition
        const appTaskDefinition = new ecs.FargateTaskDefinition(this, 'AppTaskDefinition', {
            memoryLimitMiB: 512,
            cpu: 256,
        });
        appTaskDefinition.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const appContainer = appTaskDefinition.addContainer('app', {
            image: ecs.ContainerImage.fromAsset("."),
            environment: {
                NODE_ENV: 'production',
                DATABASE_URL: 'postgresql://ponder:ponder123@postgres-service:5432/ponder',
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'app',
                logGroup: appLogGroup,
            }),
            healthCheck: {
                command: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:42069/health', '||', 'exit', '1'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
            },
        });

        appContainer.addPortMappings({
            containerPort: 42069,
            hostPort: 42069,
            appProtocol: ecs.AppProtocol.http,
            protocol: ecs.Protocol.TCP,
        });

        // IAM Role for CodeDeploy
        const codeDeployServiceRole = new iam.Role(this, 'CodeDeployServiceRole', {
            assumedBy: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCodeDeployRoleForECS'),
            ],
        });
        codeDeployServiceRole.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Application Service with Blue/Green deployment configuration
        const appService = new ecs.FargateService(this, 'AppService', {
            cluster,
            taskDefinition: appTaskDefinition,
            desiredCount: 2,
            serviceName: 'app-service',
            securityGroups: [appSecurityGroup],
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            // Enable CodeDeploy for blue-green deployments
            deploymentController: {
                type: ecs.DeploymentControllerType.CODE_DEPLOY,
            },
        });
        appService.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Application Load Balancer
        const alb = new elbv2.ApplicationLoadBalancer(this, 'AppLoadBalancer', {
            vpc,
            internetFacing: true,
            loadBalancerName: 'ponder-alb',
        });
        alb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        const listener = alb.addListener('Listener', {
            port: 80,
            open: true,
        });

        // Blue Target Group (Production)
        const blueTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BlueTargetGroup', {
            vpc,
            port: 42069,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health',
                interval: cdk.Duration.seconds(60),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
        });

        // Associate the blue target group with the service initially
        blueTargetGroup.addTarget(appService);

        // Green Target Group (Test)
        const greenTargetGroup = new elbv2.ApplicationTargetGroup(this, 'GreenTargetGroup', {
            vpc,
            port: 42069,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/ready',
                interval: cdk.Duration.seconds(60),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
            },
        });

        // Production Listener (Blue)
        listener.addAction('DefaultAction', {
            action: elbv2.ListenerAction.forward([blueTargetGroup]),
        });

        // Test Listener for Green deployments
        const testListener = alb.addListener('TestListener', {
            port: 42069,
            protocol: elbv2.ApplicationProtocol.HTTP,
            open: true,
            defaultAction: elbv2.ListenerAction.forward([greenTargetGroup]),
        });

        // Add the SNS topic for alarm notifications
        const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            displayName: 'Ponder-Test-Deployment-Alarms',
        });
        // Replace with your email address
        alarmTopic.addSubscription(new subscriptions.UrlSubscription('https://webhook.site/6b2a7721-b4c5-47ac-8530-79b30eb40df2'));


        // CloudWatch Alarm for unhealthy hosts in the green (test) deployment
        const unhealthyHostsAlarm = new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
            metric: greenTargetGroup.metrics.unhealthyHostCount(),
            threshold: 1,
            evaluationPeriods: 2,
            alarmDescription: 'Alarm if the test deployment has one or more unhealthy hosts',
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        });

        unhealthyHostsAlarm.addAlarmAction(new cw_actions.SnsAction(alarmTopic));


        // CodeDeploy Application for Blue/Green deployments
        const codeDeployApplication = new codedeploy.EcsApplication(this, 'AppCodeDeployApplication', {
            applicationName: 'ponder-app',
        });
        codeDeployApplication.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // 1. IAM Role for the promotion Lambda
        const promoterLambdaRole = new iam.Role(this, 'PromoterLambdaRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
            ],
        });

        // 2. Lambda Function to approve the deployment
        const promoterLambda = new lambda.Function(this, 'DeploymentPromoterLambda', {
            runtime: lambda.Runtime.NODEJS_20_X,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
                const { CodeDeployClient, ListDeploymentsCommand, ContinueDeploymentCommand } = require("@aws-sdk/client-codedeploy");
                exports.handler = async function(event) {
                    const client = new CodeDeployClient({ region: process.env.AWS_REGION });
                    const applicationName = process.env.APPLICATION_NAME;
                    const deploymentGroupName = process.env.DEPLOYMENT_GROUP_NAME;
                    console.log(\`Checking for ok deployments in app: \${applicationName}, group: \${deploymentGroupName}\`);
                    try {
                        const listCommand = new ListDeploymentsCommand({
                            applicationName: applicationName,
                            deploymentGroupName: deploymentGroupName,
                            includeOnlyStatuses: ['Ready'],
                        });
                        const listResult = await client.send(listCommand);
                        if (!listResult.deployments || listResult.deployments.length === 0) {
                            console.log('No deployments waiting for approval. Exiting.');
                            return;
                        }
                        const deploymentId = listResult.deployments[0];
                        console.log(\`Found waiting deployment: \${deploymentId}. Proceeding with approval.\`);
                        const continueCommand = new ContinueDeploymentCommand({
                            deploymentId: deploymentId,
                            deploymentWaitType: 'READY_WAIT'
                        });
                        await client.send(continueCommand);
                        console.log(\`Successfully triggered continuation for deployment: \${deploymentId}\`);
                    } catch (err) {
                        console.error('Error processing deployment continuation:', err);
                        throw err;
                    }
                };
            `),
            role: promoterLambdaRole,
            timeout: cdk.Duration.seconds(30),
            environment: {
                APPLICATION_NAME: 'ponder-app', // As defined in your EcsApplication
                DEPLOYMENT_GROUP_NAME: 'ponder-app-deployment-group', // As defined below in your EcsDeploymentGroup
            },
        });

        // 3. SNS Topic to trigger the promotion Lambda
        const promotionTopic = new sns.Topic(this, 'PromotionTopic', {
            displayName: 'Ponder-Deployment-Promotion-Topic',
        });
        promotionTopic.addSubscription(new subscriptions.LambdaSubscription(promoterLambda));


        // 4. CloudWatch Alarm for HEALTHY hosts to trigger PROMOTION
        const promotionAlarm = new cloudwatch.Alarm(this, 'PromotionAlarm', {
            // This metric directly counts the number of 2XX responses from the targets.
            metric: greenTargetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_2XX_COUNT, {
                statistic: 'Sum',
                period: cdk.Duration.minutes(1),
            }),
            // Expecting 2 successful health checks per minute (1 per instance)
            threshold: 2,
            evaluationPeriods: 5, // Stays healthy for 5 minutes before promotion
            alarmDescription: 'Triggers promotion when the green deployment consistently returns 2XX responses for 5 minutes.',
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        });
        promotionAlarm.addAlarmAction(new cw_actions.SnsAction(promotionTopic));

        // Grant the Lambda permission to continue the deployment
        promoterLambdaRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'codedeploy:ContinueDeployment',
                'codedeploy:ListDeployments',
            ],
            resources: [
                // Construct ARN for the deployment group
                `arn:aws:codedeploy:${this.region}:${this.account}:deploymentgroup:${codeDeployApplication.applicationName}/*`
            ],
        }));

        // CodeDeploy Deployment Group with maximum timeout values
        const deploymentGroup = new codedeploy.EcsDeploymentGroup(this, 'AppDeploymentGroup', {
            application: codeDeployApplication,
            deploymentGroupName: 'ponder-app-deployment-group',
            service: appService,
            role: codeDeployServiceRole,
            alarms: [unhealthyHostsAlarm],
            blueGreenDeploymentConfig: {
                blueTargetGroup,
                greenTargetGroup,
                listener,
                testListener,
                deploymentApprovalWaitTime: cdk.Duration.days(2),
                terminationWaitTime: cdk.Duration.minutes(5),
            },
            deploymentConfig: codedeploy.EcsDeploymentConfig.ALL_AT_ONCE,
            // Auto rollback configuration
            autoRollback: {
                failedDeployment: true,
                stoppedDeployment: true,
                deploymentInAlarm: true,
            },
        });
        deploymentGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Service Discovery for internal communication
        const serviceDiscoveryNamespace = cluster.addDefaultCloudMapNamespace({
            name: 'ponder.local',
        });

        postgresService.enableCloudMap({
            name: 'postgres',
            cloudMapNamespace: serviceDiscoveryNamespace,
        });

        // Outputs
        new cdk.CfnOutput(this, 'LoadBalancerURL', {
            value: `http://${alb.loadBalancerDnsName}`,
            description: 'URL of the Application Load Balancer (Production)',
        });

        new cdk.CfnOutput(this, 'TestLoadBalancerURL', {
            value: `http://${alb.loadBalancerDnsName}:42069`,
            description: 'URL of the Application Load Balancer (Test/Green)',
        });

        new cdk.CfnOutput(this, 'VpcId', {
            value: vpc.vpcId,
            description: 'VPC ID',
        });

        new cdk.CfnOutput(this, 'ClusterName', {
            value: cluster.clusterName,
            description: 'ECS Cluster Name',
        });

        new cdk.CfnOutput(this, 'CodeDeployApplicationName', {
            value: codeDeployApplication.applicationName,
            description: 'CodeDeploy Application Name for Blue/Green deployments',
        });

        new cdk.CfnOutput(this, 'DeploymentGroupName', {
            value: deploymentGroup.deploymentGroupName,
            description: 'CodeDeploy Deployment Group Name',
        });
    }
}

// App instantiation
const app = new cdk.App();
new EcsInfrastructureStack(app, 'PonderEcsInfrastructureStack', {
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
