"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
class AuthStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create Cognito User Pool
        this.userPool = new cognito.UserPool(this, 'UserPool', {
            userPoolName: `riftbound-${props.environment}-pool`,
            selfSignUpEnabled: true,
            autoVerify: {
                email: true,
            },
            passwordPolicy: {
                minLength: 12,
                requireLowercase: true,
                requireDigits: true,
                requireSymbols: true,
                requireUppercase: true,
            },
            mfa: cognito.Mfa.OPTIONAL,
            mfaSecondFactor: {
                sms: true,
                otp: true,
            },
            accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
            standardAttributes: {
                email: {
                    required: true,
                    mutable: false,
                },
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
        });
        // Create User Pool Client
        this.userPoolClient = this.userPool.addClient('AppClient', {
            userPoolClientName: `riftbound-${props.environment}-client`,
            generateSecret: false,
            authFlows: {
                adminUserPassword: true,
                userPassword: true,
                custom: true,
                userSrp: true,
            },
            oAuth: {
                flows: {
                    implicitCodeGrant: true,
                    authorizationCodeGrant: true,
                },
                scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
                callbackUrls: [
                    'http://localhost:3000/callback',
                    'https://riftbound.example.com/callback',
                ],
                logoutUrls: [
                    'http://localhost:3000/logout',
                    'https://riftbound.example.com/logout',
                ],
            },
            preventUserExistenceErrors: true,
        });
        // Add domain for hosted UI
        new cognito.UserPoolDomain(this, 'Domain', {
            userPool: this.userPool,
            cognitoDomain: {
                domainPrefix: `riftbound-${props.environment}`,
            },
        });
        // Create Cognito Identity Pool
        this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
            identityPoolName: `riftbound-${props.environment}-identity`,
            allowUnauthenticatedIdentities: false,
            cognitoIdentityProviders: [
                {
                    clientId: this.userPoolClient.userPoolClientId,
                    providerName: this.userPool.userPoolProviderName,
                    serverSideTokenCheck: false,
                },
            ],
        });
        // IAM role for authenticated users
        const authRole = new iam.Role(this, 'IdentityPoolAuthRole', {
            assumedBy: new iam.FederatedPrincipal('cognito-identity.amazonaws.com', {
                StringEquals: {
                    'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
                },
                'ForAllValues:StringLike': {
                    'cognito-identity.amazonaws.com:auth_type': 'authenticated',
                },
            }, 'sts:AssumeRoleWithWebIdentity'),
        });
        new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
            identityPoolId: this.identityPool.ref,
            roles: {
                authenticated: authRole.roleArn,
            },
        });
        // Output values
        new cdk.CfnOutput(this, 'UserPoolId', {
            value: this.userPool.userPoolId,
            exportName: `riftbound-${props.environment}-userpool-id`,
        });
        new cdk.CfnOutput(this, 'UserPoolArn', {
            value: this.userPool.userPoolArn,
            exportName: `riftbound-${props.environment}-userpool-arn`,
        });
        new cdk.CfnOutput(this, 'ClientId', {
            value: this.userPoolClient.userPoolClientId,
            exportName: `riftbound-${props.environment}-client-id`,
        });
        new cdk.CfnOutput(this, 'IdentityPoolId', {
            value: this.identityPool.ref,
            exportName: `riftbound-${props.environment}-identity-pool-id`,
        });
    }
}
exports.AuthStack = AuthStack;
//# sourceMappingURL=auth-stack.js.map